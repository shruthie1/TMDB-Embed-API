'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { playableUrl, proxiedSegment, PREFERRED_LANGUAGE } from '../backend';
import { languageName } from '../subtitles';
import { probeTsAudio, swapPids } from './tsAudio';
import { planPlayUrl, isEarlyFailure, markDirectFailed, logRoute, DIRECT_FIRST_FRAME_MS, DIRECT_NO_BYTES_MS } from './directRoute';
import { cachedPlaylistLoader } from './playlistCache';
import { badSegmentCounter } from './fatalPolicy';

/**
 * HLS allows every audio rendition to be marked DEFAULT=NO. That is valid
 * when a player is expected to make a language choice, but it is a bad
 * playback default when the manifest exposes only one rendition: hls.js can
 * leave audioTrack at -1 and the video then plays silently. Keep an explicit
 * default when the provider supplied one; otherwise choose the first track.
 */
export function initialAudioTrack(tracks = [], preferredLanguage = PREFERRED_LANGUAGE) {
  if (!tracks.length) return -1;
  // The viewer's language wins over the manifest's DEFAULT flag.
  //
  // This backend republishes CastleTV's muxed TS as one rendition per language
  // and marks the FIRST one DEFAULT=YES - on a five-language Indian title that
  // is Hindi. Honouring DEFAULT alone therefore started every such title in
  // Hindi and made the viewer open the Audio menu on every single play, even
  // though a Telugu rendition was sitting right there.
  //
  // Matched on the language NAME as well as the ISO code because the two
  // sources disagree: the manifest carries LANGUAGE="tel" while the API's
  // `languages` array carries "Telugu".
  if (preferredLanguage) {
    const want = String(preferredLanguage).trim().toLowerCase();
    const wanted = tracks.findIndex((t) => {
      const code = String(t.lang || '').trim().toLowerCase();
      const name = String(languageName(t.lang) || t.name || '').trim().toLowerCase();
      // Exact name ("telugu"), exact code ("tel"), or the 3-letter prefix that
      // ISO codes use. Nothing fuzzier: a substring match would make "tel"
      // select a hypothetical "Telugu (Dubbed)" over the real thing.
      return name === want || code === want || code === want.slice(0, 3);
    });
    if (wanted >= 0) return wanted;
  }
  const preferred = tracks.findIndex(t => t.default === true || t.default === 'YES');
  return preferred >= 0 ? preferred : 0;
}

/**
 * A fragment loader that exposes the audio tracks muxed inside MPEG-TS
 * segments and plays the chosen one. See tsAudio.js for why: hls.js plays only
 * the first AAC PID of a TS and offers no way to reach the others, which hid
 * Telugu on every CastleTV title in production.
 *
 * `muxed` is per-attach state: tracks (null = not probed yet), the PID hls.js
 * reads (`slot`) and the PID the viewer wants (`pid`).
 */
export function muxedAudioLoader(Base, muxed) {
  return class MuxedAudioLoader extends Base {
    load(context, config, callbacks) {
      // Byte probe for the direct-route stall check (P6): XhrLoader keeps
      // stats.loaded current from onprogress while a fragment downloads.
      try { muxed.loaders?.add(this); } catch { /* probe is optional */ }
      const onSuccess = callbacks.onSuccess;
      super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, details) => {
          // Never let this break playback: on any surprise the fragment goes
          // through untouched and plays its default track, as before.
          try { muxed.transform(response, ctx); } catch { /* play as-is */ }
          onSuccess(response, stats, ctx, details);
        },
      });
    }
  };
}

/**
 * Owns attaching hls.js and everything it reports: the quality ladder, the
 * active level and the audio tracks. Nothing else writes them.
 *
 * Quality belongs to the SOURCE, so the ladder is cleared on every attach —
 * carrying it across a source switch offered rungs the new provider does not
 * have.
 */
export function useHls({ videoRef, stream, onFatal, onHlsReady, onRouteFallback, config = {}, preferredLanguage, onLanguage }) {
  const hlsRef = useRef(null);
  // The language the VIEWER last chose, which outranks the build-time default.
  //
  // Switching server used to drop the choice: onPickSource carries only the
  // picture, so the new file fell back to initialAudioTrack's static
  // PREFERRED_LANGUAGE and then to the manifest's DEFAULT flag - which on
  // these Indian titles is Hindi. Measured 2026-09-22 on 1408162: picking
  // Telugu, then switching to VaPlayer, came back in Hindi every time.
  //
  // A ref, not a dep: this must be readable inside the hls.js event handlers
  // WITHOUT re-running the attach effect, which would tear down and rebuild
  // the player on every language pick.
  const wantLangRef = useRef(preferredLanguage);
  wantLangRef.current = preferredLanguage || PREFERRED_LANGUAGE;
  // Callbacks and config are new object identities on every render. Depending
  // on them re-ran this effect in a loop, destroying and rebuilding hls.js
  // until the tab ran out of memory. Only `stream` may trigger a re-attach.
  const cbRef = useRef({ onFatal, onHlsReady, onRouteFallback, config });
  cbRef.current = { onFatal, onHlsReady, onRouteFallback, config };
  const [levels, setLevels] = useState([]);
  const [currentLevel, setCurrentLevel] = useState(-1);   // -1 = auto
  const [autoLevel, setAutoLevel] = useState(null);       // what ABR chose
  const [audioTracks, setAudioTracks] = useState([]);
  const [currentAudio, setCurrentAudio] = useState(null);
  const muxedRef = useRef(null);
  // 'direct' | 'proxy' for the attempt running now (Player's switch checker).
  const routeRef = useRef(null);

  useEffect(() => {
    // No stale route from the previous stream (re-review m-D).
    routeRef.current = null;
    if (!stream?.masterUrl) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;

    // A new source means a new ladder. Stale rungs would offer qualities this
    // provider does not carry.
    setLevels([]); setCurrentLevel(-1); setAutoLevel(null);
    setAudioTracks([]); setCurrentAudio(null);

    // Direct vs proxy (directRoute.js): a row the server's provider config
    // marks web-direct is played from its upstream url first. A failure before
    // the first frame retries the SAME row once via the proxied masterUrl, and
    // only that attempt's failure reaches onFatal (failover).
    const plan = planPlayUrl(stream);
    logRoute(plan.mode, stream, `reason=${plan.reason}`);
    let firstFrame = false;
    let frameTimer = null;
    // P6: a direct row with NO bytes for DIRECT_NO_BYTES_MS (4 s) before the
    // first frame falls back to the proxy then, not at the 10 s cap. Bytes
    // are playlist responses, fragment progress and <video> 'progress'.
    let byteTimer = null;
    let lastBytesAt = 0;
    let byteCount = 0;
    const noteBytes = () => { lastBytesAt = Date.now(); };
    const fragBytes = () => {
      let n = 0;
      for (const l of muxedRef.current?.loaders || []) n += Number(l?.stats?.loaded) || 0;
      return n;
    };
    const stopByteWatch = () => { clearInterval(byteTimer); byteTimer = null; video.removeEventListener('progress', noteBytes); };
    let fellBack = false;
    const onFirstFrame = () => {
      firstFrame = true; clearTimeout(frameTimer); stopByteWatch();
      try { muxedRef.current?.loaders?.clear(); } catch { /* probe is optional */ }
    };
    video.addEventListener('loadeddata', onFirstFrame);
    let onNativeError = null;
    const dropNativeWatch = () => {
      if (onNativeError) video.removeEventListener('error', onNativeError);
      onNativeError = null;
    };
    let start = null; // defined below; fallBack only runs after it exists
    const fallBack = (why) => {
      if (fellBack || cancelled || firstFrame) return;
      fellBack = true;
      clearTimeout(frameTimer);
      stopByteWatch();
      dropNativeWatch();
      markDirectFailed(stream);
      logRoute('direct-failed', stream, `reason=${why} fallback=proxy`);
      // The proxy attempt gets its own full startup window (Player re-arms
      // its 15 s server-switch clock on this).
      try { cbRef.current.onRouteFallback?.(why); } catch { /* never block the retry */ }
      const old = hlsRef.current;
      hlsRef.current = null;
      try { old?.stopLoad(); } catch { /* torn down */ }
      try { old?.detachMedia(); } catch { /* already detached */ }
      try { old?.destroy(); } catch { /* already destroyed */ }
      start(stream.masterUrl, 'proxy');
    };
    const armDirect = (mode, native) => {
      if (mode !== 'direct') return;
      frameTimer = setTimeout(() => fallBack('no-first-frame-10s'), DIRECT_FIRST_FRAME_MS);
      lastBytesAt = Date.now();
      byteCount = 0;
      video.addEventListener('progress', noteBytes);
      byteTimer = setInterval(() => {
        if (firstFrame || fellBack || cancelled) { stopByteWatch(); return; }
        const n = fragBytes();
        if (n > byteCount) { byteCount = n; noteBytes(); }
        if (Date.now() - lastBytesAt >= DIRECT_NO_BYTES_MS) fallBack('no-bytes-4s');
      }, 250);
      if (native) {
        onNativeError = () => fallBack('media-error');
        video.addEventListener('error', onNativeError);
      }
    };

    start = async (url, mode) => {
      routeRef.current = mode;
      // The MANIFEST goes through the resolver proxy, because a browser cannot
      // set the `Referer` these CDNs require on a playlist. Segments are left
      // absolute and stream direct.
      //
      // Not because of `Origin`: re-measured 2026-08-31, every CDN in use
      // returns 200/206 with an Origin header. The browser-side constraint is
      // credentialed CORS, handled by withCredentials:false in hlsConfig.
      // A PROGRESSIVE source (netmirror's primary path) is a plain .mp4, not a
      // playlist. hls.js cannot play it and would report a fatal manifest
      // error, so it goes straight to the video element. It still needs the
      // proxy, because the CDN checks Referer - but /api/seg, which streams
      // bytes and honours Range, not /api/m3u8, which rewrites a playlist.
      //
      // No ladder and no #EXT-X-MEDIA graph here: one muxed file, so the
      // quality and audio menus correctly stay empty for this source.
      if (stream.progressive) {
        video.src = mode === 'direct' ? url : proxiedSegment(url, stream.referer);
        armDirect(mode, true);
        return;
      }

      const src = mode === 'direct' ? url : playableUrl(url, stream.referer);
      const { default: Hls } = await import('hls.js');
      if (cancelled) return;

      // Chrome answers "maybe" to canPlayType for HLS without really playing
      // it, and the native path exposes no level API — which is why the menu
      // used to read "Single quality". Prefer hls.js; native only for Safari.
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl') !== '') { video.src = src; armDirect(mode, true); }
        else cbRef.current.onFatal?.({ message: 'This browser cannot play HLS video.' });
        return;
      }

      // A read-only handle on the running version, so a deploy can be checked
      // from the console instead of by grepping bundles.
      try { window.__hlsVersion = Hls.version; } catch { /* SSR */ }
      // Language tracks hidden inside the TS segments. Probed from the first
      // MAIN fragments; only used when the manifest declares no renditions of
      // its own, so a real #EXT-X-MEDIA graph always wins.
      let hls = null;
      const muxed = {
        tracks: null, slot: -1, pid: -1, probes: 0, loaders: new Set(),
        active() { return Array.isArray(this.tracks) && this.tracks.length > 1; },
        transform(response, ctx) {
          if (ctx?.frag?.type !== 'main' || !(response?.data instanceof ArrayBuffer)) return;
          const u8 = new Uint8Array(response.data);
          if (this.tracks === null && this.probes < 3) {
            this.probes += 1;
            const found = probeTsAudio(u8);
            if (found && (hls?.audioTracks || []).length) this.tracks = [];
            else if (found) {
              this.tracks = found;
              if (this.active()) {
                const first = initialAudioTrack(found, wantLangRef.current);
                this.slot = found[0].pid;
                this.pid = found[first].pid;
                if (!cancelled) {
                  setAudioTracks(found.map((t, i) => ({
                    id: i, name: languageName(t.lang) || `Track ${i + 1}`, lang: t.lang,
                  })));
                  setCurrentAudio(first);
                }
              }
            }
          }
          if (this.active() && this.pid !== this.slot) swapPids(u8, this.slot, this.pid);
        },
      };
      muxedRef.current = muxed;
      const base = cbRef.current.config?.fLoader || Hls.DefaultConfig?.loader;
      // P3: playlists of kept rows come from memory (playlistCache.js).
      const pBase = cbRef.current.config?.pLoader || Hls.DefaultConfig?.loader;
      hls = new Hls(base
        ? { ...cbRef.current.config, fLoader: muxedAudioLoader(base, muxed),
          ...(pBase ? { pLoader: cachedPlaylistLoader(pBase) } : {}) }
        : cbRef.current.config);
      hlsRef.current = hls;
      cbRef.current.onHlsReady?.(hls);

      // A rung with neither RESOLUTION nor BANDWIDTH used to render "0k":
      // `Math.round(undefined/1000)` is NaN and `0/1000` is 0, so the label was
      // meaningless either way. Measured on movie/1440735, whose master
      // advertises rungs without RESOLUTION - the quality button read "0k" and
      // the menu offered "Auto 0k" and "0k". Fall back to a positional name,
      // which at least distinguishes the rungs and never lies about pixels.
      const describeLevel = (l, i, all = []) => {
        const kbps = Number(l.bitrate) > 0 ? Math.round(l.bitrate / 1000) : 0;
        // A single unlabelled level means a MEDIA playlist: nothing is
        // selectable, but the decoded picture height is still the truth and
        // beats showing "Auto" next to a stream we know is 720p.
        const decoded = all.length === 1 ? (videoRef.current?.videoHeight || 0) : 0;
        const label = l.height ? `${l.height}p`
          : kbps ? `${kbps}k`
          : all.length > 1 ? `Track ${i + 1}`
          : decoded > 0 ? `${decoded}p`
          : 'Auto';
        return {
          index: i,
          label,
          bitrate: Number(l.bitrate) > 0 ? `${(l.bitrate / 1e6).toFixed(1)} Mbps` : '',
          height: l.height || 0,
        };
      };

      // Register BEFORE loadSource: MANIFEST_PARSED fires during the load, so
      // subscribing afterwards misses it and the menu stays empty.
      // Audio renditions arrive in the EVENT DATA, and `hls.audioTracks` is not
      // populated until AUDIO_TRACKS_UPDATED fires - which is after this. Reading
      // the property here returned [] even for a manifest carrying six
      // #EXT-X-MEDIA:TYPE=AUDIO renditions (verified against Shaka's Angel One),
      // so the Audio menu never appeared. Take the data, and listen for the
      // later event too since a track list can be updated mid-stream.
      const applyAudio = (tracks) => {
        const list = tracks || [];
        // An empty rendition list says nothing about tracks inside the TS.
        if (!list.length && muxed.active()) return;
        setAudioTracks(list.map((t, i) => ({
          id: i, name: languageName(t.lang) || t.name || `Track ${i + 1}`,
          lang: t.lang || null,
        })));
        // A provider can publish one track as DEFAULT=NO (the supplied
        // MobieRulz/streamvin manifest does exactly that for Telugu). In that
        // case hls.js may retain -1, which means no audio rendition is loaded.
        // Select only when hls.js has not already selected a valid track, so
        // an intentional player/user choice is never overwritten.
        if (list.length && hls.audioTrack < 0) {
          hls.audioTrack = initialAudioTrack(list, wantLangRef.current);
        }
      };
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(hls.levels.map((l, i, all) => describeLevel(l, i, all)).sort((a, b) => b.height - a.height));
        applyAudio(data?.audioTracks);
        if (!muxed.active()) setCurrentAudio(hls.audioTrack >= 0 ? hls.audioTrack : initialAudioTrack(data?.audioTracks || [], wantLangRef.current));
        // A first fragment at the advertised top bitrate can take 10–15s on
        // the connections this catalogue sees. Start with the smallest rung
        // so the first frame arrives quickly; hls.js measures throughput from
        // that fragment and ABR can climb immediately afterward.
        // Also correct a CONFIGURED start level (HLS_CONFIG_HYBRID pins 0) when
        // the master arrived unsorted and index 0 is not actually the cheapest
        // rung. Pinning the wrong index on a hybrid is the difference between
        // a fast first frame and starting on a 20 Mbit/s 2160p variant.
        const lowestOf = () => hls.levels.reduce((best, level, index) =>
          (level.bitrate || Infinity) < (hls.levels[best]?.bitrate || Infinity) ? index : best, 0);
        if (hls.levels.length > 1 && hls.startLevel >= 0
            && hls.startLevel !== lowestOf() && cbRef.current.config?.startLevel === 0) {
          hls.startLevel = lowestOf();
        }
        if (hls.levels.length > 1 && hls.startLevel === -1) {
          const lowest = hls.levels.reduce((best, level, index) =>
            (level.bitrate || Infinity) < (hls.levels[best]?.bitrate || Infinity) ? index : best, 0);
          hls.startLevel = lowest;
        }
      });
      for (const ev of [Hls.Events.MANIFEST_LOADED, Hls.Events.LEVEL_LOADED,
        Hls.Events.AUDIO_TRACK_LOADED, Hls.Events.FRAG_LOADED]) {
        if (ev) hls.on(ev, noteBytes);
      }
      // Bad segment guard (fatalPolicy.badSegmentCounter): tiny fragments before
      // the first frame fail the row at once. Same bytes via the proxy, so no
      // direct->proxy retry: straight to onFatal (failover).
      const badSegs = badSegmentCounter();
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
        if (hlsRef.current !== hls || firstFrame) return;
        const frag = data?.frag;
        const bytes = Number(frag?.stats?.loaded ?? data?.payload?.byteLength);
        const label = badSegs.onFragment(bytes, frag?.type);
        if (!label) return;
        console.info(`[switch] ${stream?.provider || 'source'} bad segments ${label}, failing over`);
        fellBack = true; // no proxy retry: the proxy serves the same bytes
        clearTimeout(frameTimer);
        stopByteWatch();
        try { hls.stopLoad(); } catch { /* torn down */ }
        cbRef.current.onFatal?.({ fatal: true, type: 'networkError', details: 'badSegments', reason: `bad segments ${label}` }, hls);
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_e, data) => {
        applyAudio(data?.audioTracks);
        if (!muxed.active()) setCurrentAudio(hls.audioTrack >= 0 ? hls.audioTrack : initialAudioTrack(data?.audioTracks || [], wantLangRef.current));
      });
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, data) => {
        if (typeof data?.id === 'number') setCurrentAudio(data.id);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => {
        const l = hls.levels[d.level];
        if (!l) return;
        // A MEDIA playlist (no #EXT-X-STREAM-INF) makes hls.js synthesise a
        // single level with height 0 AND bitrate 0 - CastleTV's per-language
        // files are exactly this. Math.round(0/1000) then rendered the badge
        // as a meaningless "0k". describeLevel already guards this for the
        // menu; the badge reads autoLevel and needs the same guard.
        if (l.height) { setAutoLevel(`${l.height}p`); return; }
        if (Number(l.bitrate) > 0) { setAutoLevel(`${Math.round(l.bitrate / 1000)}k`); return; }
        // Fall back to what the decoder actually produced. videoHeight is the
        // true picture size and is populated once frames flow, which is the
        // honest answer when the manifest declares nothing.
        const vh = videoRef.current?.videoHeight;
        setAutoLevel(vh > 0 ? `${vh}p` : 'Auto');
      });
      // A manifest that cannot be fetched is reported by hls.js as a series of
      // NON-fatal networkErrors first: it retries with backoff and only turns
      // fatal after its retry budget runs out, which can take far longer than
      // a viewer will wait. Measured 2026-09-22 on showsst, whose CDN is behind
      // a TLS-intercepting firewall so the proxy answers 500 - four
      // manifestLoadError retries spanning 54.3s -> 61.9s, no fatal event, and
      // the player sat on a frozen frame saying nothing for ~18s.
      //
      // Escalate a repeatedly failing MANIFEST ourselves. Segment errors are
      // left alone: those are recoverable mid-playback and hls.js handles them.
      let manifestFails = 0;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (hlsRef.current !== hls) return;
        if (mode === 'direct' && isEarlyFailure(data, firstFrame)) {
          fallBack(`hls-${data?.details || 'error'}${data?.response?.code ? `-${data.response.code}` : ''}`);
          return;
        }
        if (data.fatal) { cbRef.current.onFatal?.(data, hls); return; }
        const d = data?.details;
        if (d === 'manifestLoadError' || d === 'manifestLoadTimeOut'
            || d === 'manifestParsingError') {
          const code = Number(data?.response?.code) || 0;
          // A RATE LIMIT must not be retried at all: retrying is what deepens
          // it. Measured 2026-09-22 on showsst - api.whysosigmabro.fun 302s to
          // d.whysosigmabro.fun, which answered `upstream 427` and `upstream
          // blocked` (427 = rate limited), and the api log showed NINE hits on
          // that one url while hls.js worked through its retry budget. The
          // provider was not down; we were hammering a provider that had asked
          // us to stop.
          const rateLimited = code === 429 || code === 427 || code === 503;
          manifestFails += rateLimited ? 2 : 1;
          // Two failures is enough to distinguish a dead origin from a blip,
          // and lands the message in ~3s instead of ~18s. A rate limit counts
          // double so it gives up on the FIRST response.
          if (manifestFails >= 2) {
            // stopLoad() before reporting: onFatal may leave this instance
            // alive (the 403 path re-loads rather than tearing down), and
            // without it hls.js keeps working through its own retry budget
            // underneath us against a url we have already declared dead.
            try { hls?.stopLoad(); } catch { /* torn down */ }
            const escalated = { ...data, fatal: true };
            if (mode === 'direct' && isEarlyFailure(escalated, firstFrame)) {
              fallBack(`hls-${d}${code ? `-${code}` : ''}`);
              return;
            }
            cbRef.current.onFatal?.(escalated, hls);
          }
        }
      });

      hls.loadSource(src);
      hls.attachMedia(video);
      armDirect(mode, false);
    };
    start(plan.url, plan.mode);

    return () => {
      cancelled = true;
      clearTimeout(frameTimer);
      stopByteWatch();
      dropNativeWatch();
      video.removeEventListener('loadeddata', onFirstFrame);
      // Detach the old MediaSource from the element before the next provider
      // is attached. `destroy()` normally does this, but browsers can retain
      // the previous MediaSource during a same-element source switch; the UI
      // then says the new provider is selected while the old stream keeps
      // playing (especially on TV Chromium builds).
      const oldHls = hlsRef.current;
      hlsRef.current = null;
      muxedRef.current = null;
      try { oldHls?.detachMedia(); } catch { /* already detached */ }
      try { oldHls?.destroy(); } catch { /* already destroyed */ }
      try {
        if (video.src) {
          video.pause();
          video.removeAttribute('src');
          video.load();
        }
      } catch { /* element was removed during teardown */ }
    };
  }, [stream, videoRef]);

  /**
   * Choose a quality rung, or -1 for auto.
   *
   * `currentLevel` alone forces an immediate switch that hls.js declines while
   * it is still buffering — the assignment silently reverted to -1 and the
   * picked rung never took effect. Setting the cap makes the choice STICK, and
   * `nextLevel` applies it from the next fragment without discarding what is
   * already buffered.
   */
  const pickLevel = useCallback((index) => {
    setCurrentLevel(index);
    const hls = hlsRef.current;
    if (!hls) return;
    if (index === -1) {
      hls.autoLevelCapping = -1;
      hls.currentLevel = -1;               // hand control back to ABR
      return;
    }
    hls.autoLevelCapping = index;          // ABR may not climb above it
    hls.nextLevel = index;                 // applies from the next fragment
  }, []);

  // `id` is an index into hls.audioTracks. It comes from a menu that ALSO
  // lists languages living in other sources, so an out-of-range value is
  // normal, not a programming error: measured 2026-09-22, picking Hindi on
  // Devara threw "Cannot read properties of undefined (reading 'details')"
  // from AudioTrackController.setAudioTrack and left the label switched while
  // the audio never changed. hls.js does not bounds-check, so we do, and the
  // caller falls through to pairing/substitution when we refuse.
  const pickAudio = useCallback((id) => {
    const hls = hlsRef.current;
    const idx = Number(id);
    // Tracks muxed inside the TS: point the loader at the new PID and refetch
    // from the playhead. currentLevel's setter is hls.js's own flush-and-
    // reload; assigning manualLevel back keeps the viewer's quality mode
    // (-1 stays auto). The position is kept - the buffer, not the clock, is
    // what gets thrown away.
    const muxed = muxedRef.current;
    if (hls && muxed?.active()) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= muxed.tracks.length) return false;
      setCurrentAudio(idx);
      const next = muxed.tracks[idx].pid;
      if (next !== muxed.pid) {
        muxed.pid = next;
        hls.currentLevel = hls.manualLevel;
      }
      const label = languageName(muxed.tracks[idx].lang);
      if (label) onLanguage?.(label);
      return true;
    }
    const list = hls?.audioTracks || [];
    if (!hls || !Number.isInteger(idx) || idx < 0 || idx >= list.length) return false;
    setCurrentAudio(idx);
    hls.audioTrack = idx;
    // Remember it as the standing preference, so the NEXT source switch opens
    // in this language instead of reverting to the manifest's DEFAULT.
    const picked = list[idx];
    const label = languageName(picked?.lang) || picked?.name || null;
    if (label) onLanguage?.(label);
    return true;
  }, [onLanguage]);

  return { hlsRef, routeRef, levels, currentLevel, autoLevel, audioTracks, currentAudio,
           pickLevel, pickAudio };
}
