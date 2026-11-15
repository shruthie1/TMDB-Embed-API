'use strict';

// CastleTV demux: one muxed TS -> a real HLS master with per-language audio.
//
// Extracted from apiServer.js so the media-republishing logic lives with the
// other media code instead of inside the HTTP layer. The Express routes are
// registered through registerCastleDemuxRoutes(app) rather than bound at
// import time, so this module can be required (and tested) without a server.
//
// Everything here is in-process state by design and by necessity: the job
// store, the segment cache and the ffmpeg child processes all assume a
// long-lived process. runtime.features.castleDemux gates the whole feature
// off where that assumption does not hold - see lib/runtime/environment.js.

const crypto = require('crypto');
const castleDemux = require('../../utils/castleDemux');
const runtime = require('../runtime/environment');
const { publicBase } = require('../runtime/publicBase');

// ---------------------------------------------------------------------------
// CastleTV demux: one muxed TS -> a real HLS master with per-language audio.
//
// Castle's playlist is a MEDIA playlist whose segments carry H.264 plus five
// language-tagged AAC tracks. MSE exposes only the first, so the audio menu is
// empty on a title advertising five languages. These routes republish that one
// playlist as a master: a video-only variant plus one audio rendition each,
// with every segment demuxed on demand by ffmpeg -c copy.
// ---------------------------------------------------------------------------
const CASTLE_DEMUX_TTL_MS = Number(process.env.CASTLE_DEMUX_TTL_MS) || 30 * 60 * 1000;
const castleDemuxJobs = new Map();

// The id is derived from the job's content, not random. A random id meant two
// calls for the same title minted two different ids for byte-identical jobs,
// and - the part that actually broke playback - every id died on restart,
// because this Map is in-memory. Any url a client had saved then 404'd with
// "# castle demux expired" even though nothing had expired. Hashing the
// segment list + track layout makes the same source resolve to the same id, so
// it survives a restart (the entry is re-minted on the next API call for that
// title) and repeat calls reuse one entry instead of growing the Map.
function storeCastleDemux(entry) {
  // Castle hands back a different absolute segment url on every call for the
  // same media: the CDN host rotates (img.bxncw.com -> img.bxcnm.com) and the
  // `?t=` signing timestamp is regenerated. Measured on Kuberaa, two calls one
  // after the other differed in exactly those two places while the path and
  // its 40-hex content hash stayed identical, and the track layout, segment
  // count and codec were byte-identical. So the fingerprint uses the stable
  // part of each segment - pathname only, no host, no query.
  const stableSegments = (entry.segments || []).map((u) => {
    try { return new URL(u).pathname; } catch { return String(u); }
  });
  const fingerprint = JSON.stringify([
    stableSegments,
    entry.videoIndex,
    (entry.audio || []).map((t) => [t.index, t.language, t.codec, t.channels]),
    entry.videoCodec,
  ]);
  const id = require('crypto').createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
  // Refresh the TTL on every mint so an actively-requested title stays alive.
  castleDemuxJobs.set(id, { ...entry, expiresAt: Date.now() + CASTLE_DEMUX_TTL_MS });
  return id;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, e] of castleDemuxJobs) if (e.expiresAt < now) castleDemuxJobs.delete(id);
}, 5 * 60 * 1000).unref();

function castleJob(req, res) {
  const entry = castleDemuxJobs.get(req.params.id);
  if (!entry || entry.expiresAt < Date.now()) {
    castleDemuxJobs.delete(req.params.id);
    res.status(404).send('# castle demux expired');
    return null;
  }
  return entry;
}

// The master. Written from the probe, so the rendition list reflects the
// tracks actually present rather than the title's advertised label.

function registerCastleDemuxRoutes(app) {
    app.get('/castle-demux/:id/master.m3u8', (req, res) => {
      const job = castleJob(req, res); if (!job) return;
      const base = `${publicBase(req)}/castle-demux/${req.params.id}`;
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
      // DEFAULT=YES decides what actually comes out of the speakers, because
      // hls.js starts on the default rendition. Index 0 is just whichever track
      // Castle muxed first, which has nothing to do with the film's language:
      // on Devara: Part 1 (811941), a TELUGU original, track 0 is Kannada, so
      // the demux master played Kannada. Honour PREFERRED_AUDIO_LANGUAGE and
      // fall back to index 0 only when the preferred language is absent.
      const preferred = String(process.env.PREFERRED_AUDIO_LANGUAGE || 'Telugu').toLowerCase();
      const names = job.audio.map((t, i) => castleDemux.langName(t.language) || `Audio ${i + 1}`);
      const defaultIndex = Math.max(0, names.findIndex((n, i) =>
        String(n).toLowerCase() === preferred
        || String(job.audio[i].language || '').toLowerCase() === preferred));
      job.audio.forEach((t, i) => {
        const name = names[i];
        const attrs = [
          'TYPE=AUDIO', 'GROUP-ID="castle-audio"', `NAME="${name}"`,
          t.language ? `LANGUAGE="${t.language}"` : null,
          `DEFAULT=${i === defaultIndex ? 'YES' : 'NO'}`, 'AUTOSELECT=YES',
          `URI="${base}/audio-${i}.m3u8"`,
        ].filter(Boolean);
        lines.push(`#EXT-X-MEDIA:${attrs.join(',')}`);
      });
      // Video-only CODECS on the variant: the embedded audio is being replaced by
      // the renditions above, and advertising an audio codec here makes hls.js try
      // to reconcile the two and throw fragParsingError.
      const resAttr = job.videoWidth && job.videoHeight
        ? `,RESOLUTION=${job.videoWidth}x${job.videoHeight}` : '';
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=2500000${resAttr},CODECS="${job.videoCodec}",AUDIO="castle-audio"`);
      lines.push(`${base}/video.m3u8`);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-store');
      res.send(lines.join('\n') + '\n');
    });

    // Media playlists: the original segment list with each URI pointed at our
    // demuxer, carrying the track to extract.
    function mediaPlaylist(job, base, kind, segSuffix = '') {
      const out = [];
      for (const line of job.playlistLines) {
        if (line.startsWith('#')) { out.push(line); continue; }
        const idx = job.segments.indexOf(line);
        out.push(`${base}/seg/${kind}/${idx}.ts${segSuffix}`);
      }
      return out.join('\n') + '\n';
    }

    app.get('/castle-demux/:id/video.m3u8', (req, res) => {
      const job = castleJob(req, res); if (!job) return;
      const base = `${publicBase(req)}/castle-demux/${req.params.id}`;
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-store');
      res.send(mediaPlaylist(job, base, 'v'));
    });

    // `?pts=<seconds>` rebases this rendition onto another provider's
    // timeline. Only a hybrid master ever asks for it; standalone Castle
    // playback omits it and gets the untouched source timestamps. It is
    // carried on the PLAYLIST url and stamped onto each segment url, because
    // hls.js fetches segments by the literal string we emit here.
    app.get('/castle-demux/:id/audio-:track.m3u8', (req, res) => {
      const job = castleJob(req, res); if (!job) return;
      const base = `${publicBase(req)}/castle-demux/${req.params.id}`;
      const pts = Number(req.query.pts);
      const suffix = Number.isFinite(pts) && pts !== 0 ? `?pts=${pts}` : '';
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-store');
      res.send(mediaPlaylist(job, base, `a${Number(req.params.track)}`, suffix));
    });

    // One source segment serves up to six outputs, so it is fetched once and
    // cached briefly; otherwise switching language would refetch the whole film.
    const castleSegCache = new Map();
    const CASTLE_SEG_CACHE_MAX = 40;

    async function fetchCastleSegment(url, headers) {
      const hit = castleSegCache.get(url);
      if (hit) return hit;
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`segment http ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      castleSegCache.set(url, buf);
      if (castleSegCache.size > CASTLE_SEG_CACHE_MAX) {
        castleSegCache.delete(castleSegCache.keys().next().value);
      }
      return buf;
    }

    app.get('/castle-demux/:id/seg/:kind/:n.ts', async (req, res) => {
      const job = castleJob(req, res); if (!job) return;
      const n = Number(req.params.n);
      const srcUrl = job.segments[n];
      if (!srcUrl) return res.status(404).send('no such segment');
      const kind = req.params.kind;
      const streamIndex = kind === 'v'
        ? job.videoIndex
        : (job.audio[Number(String(kind).slice(1))] || {}).index;
      if (streamIndex === undefined) return res.status(404).send('no such track');
      try {
        const src = await fetchCastleSegment(srcUrl, job.headers);
        // Video is never rebased: the hybrid takes its video from the OTHER
        // provider, so a shift here could only ever desync standalone playback.
        const pts = kind === 'v' ? 0 : Number(req.query.pts) || 0;
        const out = await castleDemux.extractTrack(src, streamIndex, pts);
        res.set('Content-Type', 'video/mp2t');
        res.set('Cache-Control', 'no-store');
        res.send(out);
      } catch (e) {
        console.error('[castle-demux] segment failed:', e.message);
        res.status(502).send('demux failed');
      }
    });
}


// Republishes a CastleTV stream as an HLS master with its muxed language
// tracks split into selectable renditions. Supersedes the CastleTV+NetMirror
// merge on any title Castle can actually play: the tracks come from the same
// file as the video, so there is no cut-matching and no cross-provider drift.
// Returns null when the stream is not demuxable, leaving the list untouched.
async function buildCastleDemuxEntry(streams, serverUrl) {
  // This feature needs two things the serverless runtime does not provide:
  // an ffmpeg binary to cut each segment, and a job store that survives
  // between requests (the master it returns points at /castle-demux/<id>/...,
  // which a LATER request must be able to resolve). On Vercel the job Map is
  // per-instance, so that follow-up request usually lands somewhere the id
  // does not exist and every rendition 404s. Returning null instead leaves the
  // ordinary CastleTV streams in place: fewer audio options, but they play.
  if (!runtime.features.castleDemux) {
    console.warn('[castle-demux] skipped: unavailable in this runtime'
      + ` (childProcesses=${runtime.capabilities.childProcesses},`
      + ` persistentMemory=${runtime.capabilities.persistentMemory})`);
    return null;
  }
  try {
    const castle = streams.find(s => s && s.url
      && String(s.provider || '').toLowerCase() === 'castletv'
      && /\.m3u8(\?|$)/i.test(String(s.url)));
    if (!castle) return null;

    const headers = castle.headers || {};
    const resp = await fetch(castle.url, { headers });
    if (!resp.ok) return null;
    const text = await resp.text();

    // Only a media playlist is demuxable here; a master would need each
    // variant handled separately.
    if (/#EXT-X-STREAM-INF/i.test(text)) return null;
    const lines = text.split(/\r?\n/);
    const baseUrl = castle.url;
    const segments = [];
    const playlistLines = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) { playlistLines.push(line); continue; }
      const abs = new URL(line, baseUrl).toString();
      segments.push(abs);
      playlistLines.push(abs);
    }
    if (!segments.length) return null;

    // Probe one segment for the real track layout. Cached per playlist.
    let probe = castleDemux.getProbe(castle.url);
    if (!probe) {
      const segResp = await fetch(segments[0], { headers });
      if (!segResp.ok) return null;
      probe = await castleDemux.probeTracks(Buffer.from(await segResp.arrayBuffer()));
      castleDemux.setProbe(castle.url, probe);
    }
    // Fewer than two audio tracks means nothing to choose between, so the
    // plain Castle stream already does the job.
    if (!probe.audio || probe.audio.length < 2) return null;

    const id = storeCastleDemux({
      segments, playlistLines, headers,
      videoIndex: probe.videoIndex,
      videoWidth: probe.videoWidth || null,
      videoHeight: probe.videoHeight || null,
      audio: probe.audio,
      videoCodec: castle.__videoCodec || 'avc1.640032',
    });

    const names = probe.audio
      .map((t, i) => castleDemux.langName(t.language) || `Audio ${i + 1}`);
    // This entry IS the audio menu - it republishes Castle's muxed tracks as
    // separate HLS renditions. Declaring audio[] and selectableAudio is what
    // tells the UI a language switcher exists here; without them the schema
    // inferred selectableAudio=false from an empty audio[] and the one stream
    // that actually offers a choice looked identical to the ones that do not.
    const audio = probe.audio.map((t, i) => ({
      language: castleDemux.langName(t.language) || null,
      codec: t.codec || null,
      channels: t.channels || null,
      index: i,
    }));
    return {
      name: `CastleTV [${names.join('/')}] - selectable audio`,
      provider: 'CastleTV',
      quality: castle.quality || 'Auto',
      url: `${serverUrl}/castle-demux/${id}/master.m3u8`,
      headers: {},
      languages: names,
      audio,
      selectableAudio: true,
      container: 'hls',
      __noProxy: true,
      ...(castle.subtitles ? { subtitles: castle.subtitles } : {}),
    };
  } catch (e) {
    console.error('[castle-demux] build failed:', e.message);
    return null;
  }
}


module.exports = {
    registerCastleDemuxRoutes,
    buildCastleDemuxEntry,
    // exported for tests
    storeCastleDemux,
    castleDemuxJobs,
};
