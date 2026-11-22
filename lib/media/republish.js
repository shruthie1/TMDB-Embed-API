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

// Every upstream fetch here is bounded. buildCastleDemuxEntry runs on the
// critical path of /api/streams, so an unbounded fetch to a CDN that accepts
// the connection and never answers held the whole response open.
const fetchTimeoutMs = () => Number(process.env.CASTLE_DEMUX_FETCH_TIMEOUT_MS) || 8000;
const segmentTimeoutMs = () => Number(process.env.CASTLE_DEMUX_SEGMENT_TIMEOUT_MS) || 30000;

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

function demuxJobId(entry) {
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
  return crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
}

// The Map below dies with the process, and every deploy restarts it: a TV
// mid-film then got 404 "# castle demux expired" on its next playlist or
// segment request. So each job spec is also written to the sqlite store
// (utils/store.js castle_demux_job) and a miss rebuilds the job from there.
// The persisted copy outlives the 30 min memory TTL, so a long film whose
// memory entry aged out mid-play is rebuilt the same way.
const CASTLE_DEMUX_PERSIST_MS = 24 * 60 * 60 * 1000;
// When the persisted row was last written, per id. A re-mint inside half the
// persist window skips the write: a spec is ~0.3 MB on a long film, and
// /api/streams re-mints on every call for the title.
const persistedAt = new Map();

// Only the playlist is stored; segments are its non-comment lines, exactly as
// demuxCastleRow builds them.
function specOf(entry) {
  return {
    playlistLines: entry.playlistLines, headers: entry.headers || {},
    videoIndex: entry.videoIndex, videoWidth: entry.videoWidth ?? null, videoHeight: entry.videoHeight ?? null,
    audio: entry.audio, videoCodec: entry.videoCodec,
  };
}

function entryFromSpec(spec) {
  if (!spec || !Array.isArray(spec.playlistLines) || !Array.isArray(spec.audio)) return null;
  return { ...spec, segments: spec.playlistLines.filter((l) => !String(l).startsWith('#')) };
}

function persistJob(id, entry) {
  const now = Date.now();
  if (now - (persistedAt.get(id) || 0) < CASTLE_DEMUX_PERSIST_MS / 2) return;
  try {
    require('../../utils/store').getStore().putDemuxJob(id, specOf(entry), now + CASTLE_DEMUX_PERSIST_MS);
    persistedAt.set(id, now);
  } catch (e) {
    console.warn(`[castle-demux] job persist failed id=${id}: ${e.message}`);
  }
}

// The id is derived from the job's content, not random. A random id meant two
// calls for the same title minted two different ids for byte-identical jobs.
// Hashing the segment list + track layout makes the same source resolve to the
// same id, and repeat calls reuse one entry instead of growing the Map.
function storeCastleDemux(entry) {
  const id = demuxJobId(entry);
  // Refresh the TTL on every mint so an actively-requested title stays alive.
  castleDemuxJobs.set(id, { ...entry, expiresAt: Date.now() + CASTLE_DEMUX_TTL_MS });
  persistJob(id, entry);
  return id;
}

// Rebuilds a job the Map does not hold (restart, or memory TTL passed) from
// its persisted spec. The id is recomputed from the spec and must match, so a
// row can never serve another title's segments. Returns the entry or null.
function rebuildCastleDemux(id) {
  let spec = null;
  try {
    spec = require('../../utils/store').getStore().getDemuxJob(id);
  } catch (e) {
    console.warn(`castle-demux: rebuild-on-miss id=${id} result=store-error err=${e.message}`);
    return null;
  }
  const entry = entryFromSpec(spec);
  if (!entry) {
    console.log(`castle-demux: rebuild-on-miss id=${id} result=not-persisted`);
    return null;
  }
  const again = demuxJobId(entry);
  if (again !== id) {
    console.error(`castle-demux: rebuild-on-miss id=${id} result=id-mismatch got=${again}`);
    return null;
  }
  const now = Date.now();
  const rebuilt = { ...entry, expiresAt: now + CASTLE_DEMUX_TTL_MS };
  castleDemuxJobs.set(id, rebuilt);
  // Playback keeps the persisted row alive for another full window.
  try {
    require('../../utils/store').getStore().touchDemuxJob(id, now + CASTLE_DEMUX_PERSIST_MS);
    persistedAt.set(id, now);
  } catch (e) {
    console.warn(`castle-demux: rebuild-on-miss id=${id} touch failed: ${e.message}`);
  }
  console.log(`castle-demux: rebuild-on-miss id=${id} result=rebuilt segments=${entry.segments.length}`
    + ` audio=${entry.audio.length}`);
  return rebuilt;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, e] of castleDemuxJobs) if (e.expiresAt < now) castleDemuxJobs.delete(id);
  for (const [id, at] of persistedAt) if (now - at > CASTLE_DEMUX_PERSIST_MS) persistedAt.delete(id);
  try { require('../../utils/store').getStore().pruneDemuxJobs(); } catch { /* telemetry-grade */ }
}, 5 * 60 * 1000).unref();

function castleJob(req, res) {
  const entry = castleDemuxJobs.get(req.params.id);
  if (entry && entry.expiresAt >= Date.now()) return entry;
  castleDemuxJobs.delete(req.params.id);
  const rebuilt = rebuildCastleDemux(req.params.id);
  if (rebuilt) return rebuilt;
  res.status(404).send('# castle demux expired');
  return null;
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
      // The variant's CODECS names the audio codec of the renditions above when
      // every one of them was probed with a known codec + profile. Without it
      // ExoPlayer cannot prepare the audio group from the master and loads all
      // renditions' playlists and first segments before the first frame
      // (apk-playback.md 2026-11-22). The demux is -c copy, so the probed codec
      // is the served codec. video.m3u8 segments carry video only (-map of the
      // video index), so there is no embedded audio for a player to reconcile.
      // Any track without a known profile (a probe stored before profiles were
      // read): video-only CODECS, as before.
      const audioCodecs = job.audio.map((t) => castleDemux.audioCodecString(t));
      const audioCodec = audioCodecs.length && audioCodecs.every(Boolean)
        ? [...new Set(audioCodecs)].join(',') : null;
      const resAttr = job.videoWidth && job.videoHeight
        ? `,RESOLUTION=${job.videoWidth}x${job.videoHeight}` : '';
      const codecs = audioCodec ? `${job.videoCodec},${audioCodec}` : job.videoCodec;
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=2500000${resAttr},CODECS="${codecs}",AUDIO="castle-audio"`);
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
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(segmentTimeoutMs()) });
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
  // Which Castle row to demux.
  //
  // Castle ships one FILE per language on many titles. Taking only the first
  // row meant a Hindi file listed before a Telugu-only file left Castle unable
  // to donate Telugu at all (docs/PENDING-WORK.md H4). Try the first row as
  // before; only when its entry lacks the wanted language, try ONE row whose
  // label names it. At most two playlist+probe fetches on this eager path; the
  // per-segment ffmpeg work stays on demand in the routes above.
  const wanted = String(process.env.PREFERRED_AUDIO_LANGUAGE || 'Telugu');
  const hls = (streams || []).filter(s => s && s.url
    && String(s.provider || '').toLowerCase() === 'castletv'
    && /\.m3u8(\?|$)/i.test(String(s.url)));
  if (!hls.length) return null;
  const first = hls[0];
  const wantedRow = hls.find(s => s !== first && labelHas(s, wanted));
  let fallback = null;
  for (const castle of [first, wantedRow].filter(Boolean)) {
    const entry = await demuxCastleRow(castle, serverUrl, wanted);
    if (!entry) continue;
    if (entry.languages.some(l => sameLanguage(l, wanted))) {
      if (castle !== first) {
        console.log(`[castle-demux] first row lacked ${wanted}; using the ${wanted}-labelled row instead`);
      }
      return entry;
    }
    if (!fallback) fallback = entry;
  }
  if (fallback && wantedRow) {
    console.log(`[castle-demux] no ${wanted} track in the first or the ${wanted}-labelled row; keeping the first row's demux`);
  }
  return fallback;
}

function sameLanguage(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  return Boolean(x && y) && (x === y || x === y.slice(0, 3));
}

// True when the row's language label (CastleTV's "Hindi/Telugu" field, or
// the [..] tag in its name) names `lang`.
function labelHas(stream, lang) {
  const bracket = (String(stream.name || '').match(/\[([^\]]+)\]/) || [])[1] || '';
  return `${stream.language || ''}/${bracket}`.split(/[/,]/)
    .some(l => sameLanguage(l.trim(), lang));
}

// A probe stored before `profile` was read (audio_evidence rows persist with
// no TTL) has no AAC profile, so its master stays video-only CODECS. Re-probe
// such a file ONCE per process, in the background (this request is served
// with the stored probe, unchanged), and copy only `profile` onto the stored
// tracks, matched by stream index and codec: the layout and language tags the
// menu and the Telugu ranking read are never replaced. A track that cannot be
// matched gets profile null (known-unknown), so it is not re-probed again.
const profileRefreshTried = new Set();
function refreshProfiles(playlistUrl, probe, firstSegment, headers) {
  const audio = Array.isArray(probe.audio) ? probe.audio : [];
  if (!audio.length || audio.every((t) => 'profile' in t)) return;
  if (profileRefreshTried.has(playlistUrl)) return;
  profileRefreshTried.add(playlistUrl);
  (async () => {
    const resp = await fetch(firstSegment, { headers, signal: AbortSignal.timeout(fetchTimeoutMs()) });
    if (!resp.ok) throw new Error(`segment http ${resp.status}`);
    const fresh = await castleDemux.probeTracks(Buffer.from(await resp.arrayBuffer()));
    const byIndex = new Map((fresh.audio || []).map((t) => [t.index, t]));
    const merged = audio.map((t) => {
      const f = byIndex.get(t.index);
      return { ...t, profile: f && f.codec === t.codec ? (f.profile || null) : null };
    });
    castleDemux.setProbe(playlistUrl, { ...probe, audio: merged });
    console.log(`[castle-demux] profile-refresh ok profiles=${merged.map((t) => t.profile || 'none').join(',')}`);
  })().catch((e) => console.warn(`[castle-demux] profile-refresh failed: ${e.message}`));
}

async function demuxCastleRow(castle, serverUrl, wanted) {
  try {
    const headers = castle.headers || {};
    const resp = await fetch(castle.url, { headers, signal: AbortSignal.timeout(fetchTimeoutMs()) });
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
    if (probe) refreshProfiles(castle.url, probe, segments[0], headers);
    if (!probe) {
      const segResp = await fetch(segments[0], { headers, signal: AbortSignal.timeout(fetchTimeoutMs()) });
      if (!segResp.ok) return null;
      probe = await castleDemux.probeTracks(Buffer.from(await segResp.arrayBuffer()));
      castleDemux.setProbe(castle.url, probe);
    }
    let tracks = probe.audio || [];
    // Two or more tracks: a real choice, demux as always. ONE track is worth
    // demuxing only when it is the wanted language, because then this file is
    // a donor: the hybrid pairing reads audio only from EXT-X-MEDIA renditions,
    // which a plain muxed Castle row does not have. Any other single track is
    // left alone - the plain Castle row already plays it.
    if (tracks.length < 2) {
      if (tracks.length !== 1) return null;
      const tagged = castleDemux.langName(tracks[0].language);
      const untagged = !tracks[0].language || String(tracks[0].language).toLowerCase() === 'und';
      if (sameLanguage(tagged, wanted)) {
        console.log(`[castle-demux] single ${wanted} track: demuxing so it can donate audio`);
      } else if (untagged && labelHas(castle, wanted)) {
        // The file does not tag its track but Castle's row says which language
        // it is. Carry that label rather than publishing an "Unknown" track
        // the Telugu-first ranking cannot see.
        const code = String(wanted).slice(0, 3).toLowerCase();
        tracks = [{ ...tracks[0], language: sameLanguage(castleDemux.langName(code), wanted) ? code : wanted }];
        console.log(`[castle-demux] single untagged track on a ${wanted}-labelled row: demuxing as ${wanted}`);
      } else {
        return null;
      }
    }

    const id = storeCastleDemux({
      segments, playlistLines, headers,
      videoIndex: probe.videoIndex,
      videoWidth: probe.videoWidth || null,
      videoHeight: probe.videoHeight || null,
      audio: tracks,
      videoCodec: castle.__videoCodec || 'avc1.640032',
    });

    const names = tracks
      .map((t, i) => castleDemux.langName(t.language) || `Audio ${i + 1}`);
    // This entry IS the audio menu - it republishes Castle's muxed tracks as
    // separate HLS renditions. Declaring audio[] and selectableAudio is what
    // tells the UI a language switcher exists here; without them the schema
    // inferred selectableAudio=false from an empty audio[] and the one stream
    // that actually offers a choice looked identical to the ones that do not.
    const audio = tracks.map((t, i) => ({
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
    rebuildCastleDemux,
    castleDemuxJobs,
    _persistedAt: persistedAt,
};
