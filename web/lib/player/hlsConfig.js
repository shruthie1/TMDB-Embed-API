/**
 * hls.js configuration.
 *
 * Every value here was set from a measurement, not a default — the comments
 * record which, so nobody "tidies" one back into a stall.
 */
export const HLS_CONFIG = {
  // BUFFER: a compromise between two findings that pull in opposite
  // directions. Both were measured; neither can be had in full.
  //
  // FINDING 1 (why this was raised to 120s): segments here are ~10.8MB for 6s
  // of video (~14 Mbps). At maxBufferLength:30 hls.js filled 30s, went idle,
  // then restarted - and each restart abandoned an in-flight fragment, the
  // (canceled) rows at 11.8s and 28.9s in the network log.
  //
  // FINDING 2 (why 120s was wrong): hls.js abandons an in-flight fragment only
  // when finishing it would outlast the buffer -
  //
  //     if (fragLoadedDelay <= bufferStarvationDelay) return;   // abr-controller
  //
  // and bufferStarvationDelay IS the buffer length. At 120s a fragment had to
  // take over two MINUTES before the emergency down-switch fired, so the large
  // buffer silently disabled the 100ms check that is meant to catch a dip. That
  // is the "buffers instead of dropping quality" the viewer reported.
  //
  // 20s, lowered from 30s for INCONSISTENT bandwidth, where the buffer is the
  // deadline rather than the cushion. Modelled against the measured segment
  // size (~10.8MB per 6s at ~14 Mbps), the drop fires this late:
  //
  //     dip to      30s buffer     20s buffer
  //     6 Mbps      16s late       6s late
  //     4 Mbps       8s late       ON TIME
  //     3 Mbps       1s late       ON TIME
  //
  // 3-4 Mbps is exactly where an unstable connection sits: fast enough that
  // ABR is tempted to hold a high rung, too slow to sustain it. At 30s that
  // is the residue of the same fault 120s caused outright - the picture
  // freezes while quality stubbornly stays high.
  //
  // The trade is real, not free: 20s is 10s less runway before a stall, and
  // the idle-restart churn of Finding 1 happens ~50% more often on a healthy
  // connection. A cancelled fragment is wasted bandwidth; a late down-switch
  // is a stall the viewer watches.
  //
  // It does NOT make climbing more aggressive: the up-switch is gated by the
  // bandwidth estimate against abrBandWidthUpFactor, and the buffer is not
  // part of that test. ABR re-evaluates per fragment at either length, so
  // rung flapping - the failure that would make unstable bandwidth feel
  // worse - is unaffected.
  maxBufferLength: 20,
  maxMaxBufferLength: 90,

  // Memory is the real limit, not time: 10 min of 14 Mbps video is ~1GB,
  // which a TV box cannot hold. This cap is what actually bounds it; the
  // length targets just stop it reaching for more. Chrome enforces its own
  // MSE quota on top, so this is a ceiling we ask for, not one we are given.
  maxBufferSize: 600 * 1000 * 1000,   // 600 MB

  backBufferLength: 60,               // instant back-seeks without hoarding
  maxBufferHole: 0.5,                 // do not stall on a tiny gap

  // Let ABR choose the opening rung. The ladder reaches 16 Mbps and a cold
  // start there stalls on a connection measured as low as 4.4 Mbps.
  startLevel: -1,

  // NOT capLevelToPlayerSize: it caps quality to the element's pixel size,
  // and an element not yet laid out reports 0 — hls.js then loads NO level.
  // Symptom: master fetched 200, no variant request, no error, readyState 0.
  capLevelToPlayerSize: false,

  lowLatencyMode: false,

  // ABR: DROP FAST, CLIMB SLOWLY.
  //
  // hls.js's defaults assume short segments. This catalogue's are 3-8MB and
  // legitimately take 6-10s, so the defaults reacted far too slowly:
  //
  //   abrEwmaFastVoD: 3     averaged over 3 FRAGMENTS - at 6s each that is
  //                         ~18s of history, so a bandwidth dip took ~18s to
  //                         register and the viewer buffered throughout.
  //   maxStarvationDelay: 4 assumed a rung could be recovered inside 4s, which
  //                         is shorter than one segment here.
  //
  // The window is now measured in seconds of playback rather than fragments.
  abrEwmaFastVoD: 1.5,      // react to a dip within ~1.5s, not ~18s
  abrEwmaSlowVoD: 6,        // steady baseline, so one blip does not drop a rung

  // Assume a modest connection until measured, rather than hls.js's 500kbps.
  // Too low and the opening rung is needlessly poor; too high and the first
  // segment stalls. 1.5 Mbps starts on a mid rung on the connections measured
  // here (as low as 4.4 Mbps).
  abrEwmaDefaultEstimate: 1_500_000,

  // Use only 80% of the measured bandwidth when choosing a rung, and require
  // 60% headroom before climbing. Asymmetric on purpose: dropping early costs
  // a little sharpness, climbing early costs a stall, and a stall is worse.
  abrBandWidthFactor: 0.8,
  abrBandWidthUpFactor: 0.6,

  // Judge a rung by the bitrate actually observed, not the manifest's claim -
  // these CDNs under-declare, so a rung that says 6 Mbps can deliver more.
  abrMaxWithRealBitrate: true,

  // A segment here can take 10s, so allow real time to recover before giving
  // up on a rung. Below one segment duration these thresholds fire constantly
  // and cause the very thrash they are meant to prevent.
  maxStarvationDelay: 10,
  maxLoadingDelay: 10,

  // Segments are 3-8MB on these CDNs and legitimately take 10s+. The 20s
  // default is far too tight when throughput dips to ~1 Mbps.
  fragLoadingTimeOut: 45000,
  manifestLoadingTimeOut: 20000,
  fragLoadingMaxRetry: 4,
  manifestLoadingMaxRetry: 3,
  levelLoadingMaxRetry: 3,

  xhrSetup: (xhr) => {
    // CREDENTIALS, not the Origin header. Re-measured 2026-08-31 across both
    // CDNs (quietnexus.top and proxy2.heistotron.uk), seven header
    // combinations each: bare, UA, +Referer, +Origin, Origin alone, a foreign
    // Origin, and +Cookie ALL return 206. An Origin header is harmless.
    //
    // What fails is credentialed CORS. Both CDNs send
    //   access-control-allow-origin: *
    // and NO access-control-allow-credentials, and a wildcard origin is
    // invalid with credentials - so the browser blocks the response before it
    // is read. Verified from the live origin: `credentials: 'omit'` returns
    // 206 with bytes, `credentials: 'include'` throws "Failed to fetch".
    //
    // So this line is required, and setting a request header here is still
    // wrong - it forces a preflight these CDNs do not answer - but the reason
    // is CORS credentials, not Origin. The earlier note claiming "+Origin 403"
    // did not reproduce and would send the next reader down a dead end.
    xhr.withCredentials = false;
  },
};

/**
 * Is this a TV / set-top box rather than a laptop or phone?
 *
 * TVs are the constrained device here: a mid-range box has a fraction of a
 * laptop's RAM and a much weaker decoder, and the buffer values above were
 * measured on a laptop. Asking a TV for 600MB and ten minutes of 4K is how you
 * get the stuttering the tuning was meant to prevent.
 *
 * Detection is by user agent, which is unreliable in general but is the only
 * signal available here - there is no API for "this is a television". Widely
 * seen TV platform tokens, plus deviceMemory when the browser reports it.
 */
export function isTvDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // vidaa / hisense / odin/ are Hisense VIDAA, whose browser is a Chromium
  // build called Odin. Its UA usually carries SmartTV too, but not always.
  const tvToken = /\b(smart-?tv|smarttv|googletv|android\s*tv|appletv|hbbtv|netcast|viera|aquos|bravia|webos|web0s|tizen|crkey|chromecast|firetv|aft[a-z]|silk|dtv|philipstv|opera\s*tv|large\s*screen|vidaa|hisense)\b|\bodin\//i.test(ua);
  // A device reporting 2GB or less is treated as constrained regardless of
  // what it calls itself. deviceMemory is coarse (powers of two, capped at 8)
  // and absent on Safari/Firefox, so it can only ever add a positive.
  const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 2;
  return tvToken || lowMemory;
}

/**
 * Buffer targets trimmed for a constrained device.
 *
 * Everything that is not about memory or decode is inherited unchanged - the
 * CDN timeouts, the retry counts, the xhrSetup that avoids credentialed CORS are
 * all as true on a TV as anywhere.
 *
 * NOT capLevelToPlayerSize even here: it reads the element's pixel size, which
 * is 0 before layout, and hls.js then loads no level at all. The cap below is
 * applied to the ladder instead, once the levels are known.
 */
export const HLS_CONFIG_TV = {
  ...HLS_CONFIG,
  // Length now matches the laptop profile; what a TV cannot afford is MEMORY.
  //
  // The BYTE cap is what binds here, not the length. At ~10.8MB per 6s segment,
  // 60MB was only ~33s of 4K - below the 60s ceiling - so ABR could never
  // reach that ceiling however good the line was. 150MB is ~83s, which puts
  // the length ceiling back in charge; past that the cap buys nothing, since
  // 60s is then the limit.
  //
  // Safe to raise because it is a CEILING, not the target: maxBufferLength
  // (20s) is the down-switch deadline, and it is untouched. Extra bytes are
  // only ever fetched when bandwidth is genuinely spare, which is exactly the
  // case worth hoarding for on an unreliable line.
  //
  // Deliberately short of the laptop's 600MB. This profile also covers any
  // device reporting <=2GB of memory (see isTvDevice), where a 600MB media
  // buffer is most of the machine. Chrome enforces its own MSE quota on top,
  // so this is a ceiling we ask for, not one we are promised.
  maxMaxBufferLength: 60,
  maxBufferSize: 150 * 1000 * 1000,   // 150MB, not 60
  backBufferLength: 15,               // enough for a short back-seek

  // A small buffer has to be defended more actively than a large one: with
  // only 30s of runway there is no slack to absorb a bad rung, so drop sooner
  // and climb more grudgingly than on a laptop.
  abrEwmaFastVoD: 1,
  abrBandWidthFactor: 0.7,
  abrBandWidthUpFactor: 0.5,
  // Starvation thresholds must still exceed one segment (6-10s) or they fire
  // constantly; but with a 30s buffer, waiting the full 10s spends a third of
  // the runway, so this sits just above a single segment.
  maxStarvationDelay: 8,
  maxLoadingDelay: 8,
};

/** The config this device should use. */
/**
 * A hybrid stream binds one provider's video to another's audio renditions
 * (utils/hybridStream.js on the backend). The two sides are the same CUT - the
 * runtimes agree to within a fraction of a second - but they are NOT segmented
 * the same way, and the defaults above assume they are.
 *
 * Measured 2026-09-22 on Devara (811941), showsst video + castle-demux audio:
 *   video  2060 fragments, every one exactly 5.000s
 *   audio  3378 fragments, 3.75 / 4.08 / 6.125 / 1.00 / 3.75 ...
 *          1312 of 3378 (39%) are shorter than 2s
 *   total  10299.58s vs 10299.63s - 0.05s apart over 171 minutes
 *   fragment boundaries drift up to 1.96s apart mid-film
 *
 * So cumulative timing is excellent and BOUNDARIES are ragged. That combination
 * breaks seeking under the defaults: hls.js seeks to a video fragment, looks for
 * the audio fragment covering that timestamp, and with maxBufferHole at 0.5s it
 * treats a sub-second edge mismatch as a real gap and stalls instead of playing
 * across it. Meanwhile each 1s audio fragment buys only 1s of playback, so it
 * needs 5-6 round trips to cover one video fragment while that fragment itself
 * measured 4.4s to fetch.
 *
 * These values are therefore not "more buffering is better" - each one answers a
 * number above.
 */
export const HLS_CONFIG_HYBRID = {
  ...HLS_CONFIG,

  // Must exceed the worst measured boundary drift (1.96s), or a seek lands in
  // what hls.js reads as a hole and the playhead never advances.
  maxBufferHole: 2.5,

  // Same reason, on the lookup side: the fragment whose range brackets the seek
  // target can start up to ~2s off. The default 0.25s rejects it and hls.js
  // reports "fragment not found" rather than playing the one that is there.
  maxFragLookUpTolerance: 2.5,

  // 39% of audio fragments are under 2s, so a fixed fragment COUNT buys very
  // little wall-clock. Buffer by time instead, and keep more of it: this is the
  // difference between riding over a ragged patch and stalling in it.
  maxBufferLength: 60,
  backBufferLength: 90,

  // A stall here is a boundary artefact, not a dead stream. Nudging harder and
  // more often recovers it silently; the default gives up and surfaces an error
  // to the viewer for something that would have resolved itself.
  nudgeMaxRetry: 10,
  nudgeOffset: 0.2,
  highBufferWatchdogPeriod: 1,

  // Start at the BOTTOM rung and climb grudgingly.
  //
  // A hybrid pairs a remote picture with local audio, and the picture must go
  // through /m3u8-proxy because the browser cannot set the provider's Referer.
  // That makes the video side the expensive half while the audio side is
  // nearly free, which skews what ABR measures: the cheap audio fragments make
  // throughput look better than the line can actually sustain for video.
  //
  // Measured 2026-09-23 on movie/1290190 (mapple 2160p + CastleTV Telugu):
  //   4k segments  4.98-5.45 MB each, covering ~2.1s of video
  //                = ~20 Mbit/s sustained
  //   cold fetch   2.26-3.62s via proxy, 1.95-2.78s DIRECT
  // So the proxy is NOT the bottleneck - the ladder is simply above what the
  // line carries. With the inherited defaults hls.js climbed to 4k on the back
  // of warm early fragments, then starved: the buffer hit 0 and the picture
  // collapsed 1080 -> 720 -> 360 with the playhead frozen at t=341.7.
  //
  // startLevel is pinned in CONFIG rather than at MANIFEST_PARSED because by
  // then the first fragment request is already in flight at the advertised top
  // rung - the existing handler in useHls.js only takes effect from the second
  // fragment on. hls.js sorts levels by bitrate ascending, so 0 is the
  // cheapest rung; useHls still recomputes the true minimum defensively for a
  // master that arrives unsorted.
  //
  // A cheap first frame, then a real climb.
  //
  // The first attempt at this pinned the TV profile's up-factor (0.5) here as
  // well, and that was too grudging for a ladder with this much space between
  // rungs: measured on 1290190 the picture started at 360p and was STILL 360p
  // 36s later with 87s buffered ahead - it had bandwidth to spare and would
  // not spend it. Starting cheap is the point; staying cheap is a bug.
  //
  // 0.8 asks a climb to be supported by measured throughput with a modest
  // margin, while the DOWN factor stays conservative so a dip still drops
  // quickly. Asymmetric on purpose: over-reaching on this ladder costs a stall
  // (5MB segments, ~20 Mbit/s at the top), while dropping a rung costs pixels.
  startLevel: 0,
  abrBandWidthFactor: 0.7,
  abrBandWidthUpFactor: 0.8,
  maxStarvationDelay: 8,
  maxLoadingDelay: 8,
};

/**
 * `hybrid` picks the profile above. It is passed explicitly by the player
 * rather than sniffed from the URL, so a stream that merely looks synthetic
 * cannot silently opt into looser gap handling.
 */
export function configFor({ tv = isTvDevice(), hybrid = false } = {}) {
  if (hybrid) {
    return tv ? { ...HLS_CONFIG_TV, ...HLS_CONFIG_HYBRID, maxBufferSize: HLS_CONFIG_TV.maxBufferSize,
                  maxMaxBufferLength: HLS_CONFIG_TV.maxMaxBufferLength }
              : HLS_CONFIG_HYBRID;
  }
  return tv ? HLS_CONFIG_TV : HLS_CONFIG;
}

/**
 * Cap ABR for a connection that has already declared itself constrained.
 * A missing Network Information API means unknown, so bandwidth-driven ABR
 * is left alone rather than penalising Safari and Firefox.
 */
export function networkLevelCap(levels = [], connection) {
  if (!levels.length || !connection) return -1;
  const type = String(connection.effectiveType || '').toLowerCase();
  const downlink = Number(connection.downlink);
  let maxHeight = null;
  if (connection.saveData || type === 'slow-2g') maxHeight = 360;
  else if (type === '2g') maxHeight = 480;
  else if (type === '3g') maxHeight = 720;
  else if (Number.isFinite(downlink)) {
    if (downlink < 2) maxHeight = 720;
    else if (downlink < 4) maxHeight = 1080;
  }
  if (!maxHeight) return -1;
  const eligible = levels
    .map((l, i) => ({ i, h: l.height || 0 }))
    .filter(l => l.h > 0 && l.h <= maxHeight)
    .sort((a, b) => b.h - a.h);
  if (eligible.length) return eligible[0].i;
  const labelled = levels.map((l, i) => ({ i, h: l.height || 0 }))
    .filter(l => l.h > 0).sort((a, b) => a.h - b.h);
  return labelled.length ? labelled[0].i : -1;
}

/**
 * Highest rung a constrained device should be allowed to climb to.
 *
 * A 4K rung on this catalogue is ~16 Mbps, and a TV box that cannot decode it
 * in real time drops frames and rebuffers rather than failing outright - which
 * looks exactly like a network problem. Capping at 1080p keeps the picture
 * within what these boxes reliably decode, and 1080p on a TV at normal viewing
 * distance is not a visible loss.
 *
 * Returns the level INDEX to cap at, or -1 for no cap. The viewer can still
 * pick a higher rung by hand; this only bounds what ABR reaches for on its own.
 */
export const TV_MAX_HEIGHT = 1080;

export function tvLevelCap(levels = []) {
  if (!levels.length) return -1;
  const withinCap = levels
    .map((l, i) => ({ i, h: l.height || 0 }))
    .filter(l => l.h > 0 && l.h <= TV_MAX_HEIGHT);
  if (!withinCap.length) {
    // Every rung is above the cap (a 4K-only ladder): take the smallest rather
    // than refusing to play. But if NO rung reports a height at all, there is
    // nothing to reason about - capping to index 0 would pin a TV to whatever
    // happened to be listed first, so leave ABR alone.
    const labelled = levels
      .map((l, i) => ({ i, h: l.height || 0 }))
      .filter(l => l.h > 0)
      .sort((a, b) => a.h - b.h);
    return labelled.length ? labelled[0].i : -1;
  }
  return withinCap.sort((a, b) => b.h - a.h)[0].i;
}

/**
 * Highest rung ABR may reach for on an ordinary screen.
 *
 * This is a BANDWIDTH decision, not a decode one. Web playback relays every
 * segment through /api/seg on Vercel, so each byte ABR asks for is billed as
 * Fast Origin Transfer. Measured 2026-09-13: 302 segments over 5MB moved
 * 1.88GB (mean 6.2MB) while the same four seconds at a sane rung is ~1.0MB,
 * and the free 10GB allowance was spent in nine days of light use.
 *
 * 1080p rather than 720p because this is a ceiling on a television-sized
 * picture, and nobody in the household watches on a 4K panel - the 4K rung
 * costs roughly 2.6x the bytes for a picture no screen here can show.
 *
 * The viewer's manual quality picker sets `currentLevel`, which ABR capping
 * does not touch, so 4K remains available by hand on a source that has it.
 *
 * Returns a level INDEX, or -1 for no cap. Mirrors tvLevelCap's contract: an
 * unlabelled ladder is left alone rather than pinned to whatever is listed
 * first.
 */
export const DEFAULT_MAX_HEIGHT = 1080;

export function defaultLevelCap(levels = []) {
  if (!levels.length) return -1;
  const withinCap = levels
    .map((l, i) => ({ i, h: l.height || 0 }))
    .filter(l => l.h > 0 && l.h <= DEFAULT_MAX_HEIGHT);
  if (!withinCap.length) {
    // A ladder with nothing at or below the cap must still play.
    const labelled = levels
      .map((l, i) => ({ i, h: l.height || 0 }))
      .filter(l => l.h > 0)
      .sort((a, b) => a.h - b.h);
    return labelled.length ? labelled[0].i : -1;
  }
  return withinCap.sort((a, b) => b.h - a.h)[0].i;
}
