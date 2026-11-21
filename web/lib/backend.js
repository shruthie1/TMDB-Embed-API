'use client';

/**
 * Adapter: TMDB-Embed-API  ->  the shape this UI was built for.
 *
 * This UI came from the Chitram repo, where the backend was a "resolver" that
 * streamed NDJSON progress events and answered with {masterUrl, referer}.
 * The backend here is different in three ways, and this file is the only
 * place that knows it:
 *
 *   1. It returns ONE JSON response after the provider fan-out, not a live
 *      event feed. So the progress log is synthesised (see resolveLive).
 *   2. Its stream objects are `{url, provider, quality, levels, languages,
 *      audio, selectableAudio, container}` - the canonical shape from
 *      utils/streamSchema.js - not `{masterUrl, referer}`.
 *   3. It proxies upstream Referer itself (proxy/proxyServer.js rewrites every
 *      url through /m3u8-proxy), so the browser never needs to send one. That
 *      is why `referer` is always null below rather than threaded through.
 *
 * Keeping the translation here means the components stay byte-identical to the
 * Chitram originals - the reason the UI looks the same is that it IS the same.
 */

// Empty means same-origin, which is the normal case: next.config.mjs rewrites
// the backend's routes to the Express API, so the browser never needs its
// origin and there is no CORS to configure. Set NEXT_PUBLIC_API_BASE only to
// point a local UI at a remote backend.
import { abortReason } from './abortReason';
import { isUnsupported } from './player/codecSupport';

const BASE = process.env.NEXT_PUBLIC_API_BASE || '';

/** The viewer's preferred audio language. */
export const PREFERRED_LANGUAGE =
  process.env.NEXT_PUBLIC_PREFERRED_LANGUAGE || 'Telugu';

async function getJson(path, { timeoutMs = 60000, signal } = {}) {
  const ac = new AbortController();
  // Abort WITH a reason. A bare abort() surfaces as "signal is aborted without
  // reason" in Next's dev overlay at the throw site, even though every caller
  // here handles it (listSources catches, resolveLive checks signal.aborted).
  const timer = setTimeout(() => ac.abort(abortReason(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ac.abort(signal.reason ?? abortReason('caller cancelled'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(`${BASE}${path}`, { cache: 'no-store', signal: ac.signal });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return await r.json();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Waits before the 2nd and 3rd attempt at /api/streams. Exported (and
 * mutable) only so tests can run without real sleeps.
 *
 * A retry is worth it for a dropped connection or a 5xx/429: a VM restart, a
 * Vercel rewrite hiccup or mobile handover. It is NOT worth it for a 4xx (the
 * request itself is wrong), a caller cancel, or our own timeout (the backend
 * already spent its full budget; asking again doubles the wait).
 */
export const STREAMS_RETRY_DELAYS_MS = [800, 2500];
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});
const retryable = (err) => (err?.status ? err.status >= 500 || err.status === 429 : !isAbortLike(err));
function isAbortLike(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timeout after|cancel|superseded/i.test(String(err?.message || ''));
}
async function getJsonWithRetry(path, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getJson(path, opts);
    } catch (err) {
      if (opts.signal?.aborted || attempt >= STREAMS_RETRY_DELAYS_MS.length || !retryable(err)) throw err;
      await sleep(STREAMS_RETRY_DELAYS_MS[attempt], opts.signal);
    }
  }
}

/**
 * Per-title cache of the last COMPLETE /api/streams answer, in sessionStorage.
 *
 * The request is no-store (signed urls), so every replay of a title, every
 * back-navigation and every episode re-open re-ran the whole provider fan-out
 * (2-10s). Kept 4 minutes: under the backend's own 300s browser TTL and well
 * under the providers' signed-url lifetimes. A partial early answer (the
 * backend marks it) is never cached, so the next ask picks up the late rows.
 * Nor is an answer where a provider errored (`providerErrors`).
 * A stale url is handled by the player: a 403 re-resolves with refresh, which
 * skips this cache. Storage failures (private mode, quota) are ignored.
 */
const STREAMS_CACHE_TTL_MS = 4 * 60 * 1000;
const cacheKey = (type, id, season, episode) => `chitram:streams:${type}:${id}:${season || 0}:${episode || 0}`;
function cacheGet(key) {
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    if (!raw) return null;
    const { at, d } = JSON.parse(raw);
    if (!(Date.now() - at < STREAMS_CACHE_TTL_MS)) { globalThis.sessionStorage.removeItem(key); return null; }
    return d;
  } catch { return null; }
}
function cachePut(key, d) {
  try {
    if (d?.partial || !Array.isArray(d?.streams) || !d.streams.length) return;
    // A provider threw on this answer (backend lists it in providerErrors).
    // Caching it would hide that server for 4 minutes after a short blip.
    if (Array.isArray(d.providerErrors) && d.providerErrors.length) return;
    globalThis.sessionStorage?.setItem(key, JSON.stringify({ at: Date.now(), d }));
  } catch { /* private mode or quota: no cache, still plays */ }
}

/**
 * One /api/streams request per title at a time, shared by every caller.
 *
 * The title page warms the list while the viewer reads (prewarmStreams), and
 * Play then joins that request instead of starting a second fan-out. Not
 * aborted when one caller goes away: the answer still lands in the session
 * cache and the backend's own cache, which is the point of warming.
 * A refresh never joins: it exists to mint new signed urls.
 */
const inflight = new Map();
function fetchStreamsShared(key, path) {
  const running = inflight.get(key);
  if (running) return running;
  const p = getJsonWithRetry(path, { timeoutMs: 120000 })
    .then((d) => { cachePut(key, d); return d; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Start resolving a title the viewer has opened, before Play is pressed.
 *
 * Only for the title page, which is a strong play intent. Hover and D-pad
 * dwell stay on the no-op in lib/prefetch.js: a row of cards must not start a
 * fan-out for every title the pointer crosses. Fire-and-forget.
 */
export function prewarmStreams(type, id, { season = 0, episode = 0 } = {}) {
  if (!id) return;
  const key = cacheKey(type, id, season, episode);
  if (cacheGet(key) || inflight.has(key)) return;
  fetchStreamsShared(key, endpoint(type, id, { season, episode })).catch(() => {});
}

/**
 * One backend stream -> one UI "source".
 *
 * `masterUrl` is what useHls attaches. `referer` stays null on purpose: see
 * point 3 above. Sending one would be harmless but misleading - it would
 * suggest the browser is authenticating to the CDN when the server already did.
 */
function isHls(s) {
  const c = String(s.container || '').toLowerCase();
  if (c) return c === 'hls';
  // No container stated: fall back to the url, allowing for the proxy wrapper.
  const u = String(s.url || '');
  return /\.m3u8(\?|$)/i.test(u) || /m3u8-proxy|[?&]url=[^&]*m3u8/i.test(u);
}

export function toSource(s, i = 0) {
  if (!s || !s.url) return null;
  const languages = Array.isArray(s.languages) ? s.languages : [];
  return {
    // Aggregate and supplemental NetMirror replies have different indexes.
    // Identify a catalog/quality row by the same URL identity used by mergeSources.
    id: String(s.provider || '').toLowerCase() === 'netmirror'
      ? `netmirror-${encodeURIComponent(JSON.stringify([s.url, s.quality || 'Auto']))}`
      : `${s.provider || 'src'}-${i}`,
    provider: s.provider || s.name || 'Unknown',
    label: s.title || s.provider || 'Stream',
    masterUrl: s.url,
    // The upstream url, only when the server's provider config says a browser
    // can fetch it without the proxy (lib/routing/providerRoutes.js). useHls
    // tries it first and falls back to masterUrl on the same row.
    webDirectUrl: s.route?.web === 'direct' && typeof s.directUrl === 'string' && s.directUrl
      ? s.directUrl : null,
    referer: null,
    // Anything not HLS goes to <video src> directly rather than through
    // hls.js - useHls branches on this.
    //
    // Decided by `container`, NOT by the url. Every url here is already
    // rewritten to `/m3u8-proxy?url=<encoded>` by proxy/proxyServer.js, so the
    // ".m3u8" is inside an encoded query parameter and a url test reports HLS
    // masters as progressive. That sends a real HLS master to <video src>,
    // where it plays without hls.js and therefore with NO quality ladder and
    // NO audio menu - exactly the two things this UI is for. Measured on
    // Irumudi: 4 of 5 streams were misclassified this way.
    progressive: !isHls(s),
    quality: s.quality || 'Auto',
    // The measured ladder when the backend knows it (lib/media + the provider
    // fix in providers/vaplayer.js). [] means unknown, never "one level".
    levels: Array.isArray(s.levels) ? s.levels : [],
    languages,
    netmirrorCatalog: s.netmirrorCatalog || null,
    catalogLanguages: Array.isArray(s.catalogLanguages) ? s.catalogLanguages : [],
    audio: Array.isArray(s.audio) ? s.audio : [],
    // True only when the manifest really carries selectable renditions, so the
    // Audio menu is not offered on a stream that cannot switch.
    selectableAudio: Boolean(s.selectableAudio),
    incomplete: Boolean(s.incomplete),
    // A synthetic master binding one provider's video to another's audio
    // (utils/hybridStream.js). It is the only way to get the best video AND
    // the preferred language on titles where no single provider has both, so
    // the ranking treats it as the top tier.
    hybrid: Boolean(s.hybrid),
    subtitles: Array.isArray(s.subtitles) ? s.subtitles : [],
    // The video codec the backend measured ("hevc", "avc", ...; null when not
    // known) and the master's CODECS string. `unsupported` is true only when
    // this browser is known NOT to decode it: such a row plays audio over a
    // black screen (The Paradise, 1376856, HEVC on Chrome Android), so it is
    // ranked last and marked in the server menu. It can still be picked.
    videoCodec: s.videoCodec || null,
    codecString: typeof s.codecs === 'string' ? s.codecs : null,
    unsupported: isUnsupported({ videoCodec: s.videoCodec, codecString: s.codecs }),
  };
}

/** Pixel height of a source's best level, for ranking. 0 when unknown. */
export function sourceHeight(s) {
  const fromLevels = (s?.levels || [])
    .map((l) => Number(l?.height) || 0)
    .reduce((m, h) => (h > m ? h : m), 0);
  if (fromLevels) return fromLevels;
  const m = String(s?.quality || '').match(/(\d{3,4})p/);
  return m ? Number(m[1]) : 0;
}

/**
 * Rank sources so the RIGHT one is already playing.
 *
 * The viewer chooses nothing. Measured across 16 Telugu titles on 2026-09-22,
 * every one of them had 1080p video but only 9 had the preferred language at
 * all - so the scarce resource is LANGUAGE, not pixels, and the ranking spends
 * resolution to buy it rather than the other way round.
 *
 * The order is a fallback chain, best tier first:
 *
 *   1. HYBRID - best video bound to preferred-language audio, in sync. The
 *      only tier that gets both. Offered on 7 of the 16.
 *   2. PREFERRED LANGUAGE, switchable - a real multi-track master. Switching
 *      language keeps the playback position.
 *   3. PREFERRED LANGUAGE, any resolution - 4 more titles (Salaar, RRR, Saaho,
 *      Maharshi) carry Telugu ONLY below HD. 720p Telugu beats 1080p Hindi:
 *      the standing requirement is the language.
 *   4. SWITCHABLE audio - no preferred language anywhere, but the viewer can
 *      at least choose.
 *   5. Anything else, best resolution first - the remaining 5 titles have no
 *      Telugu at all. Play rather than refuse.
 *
 * Within a tier the server's order stands: the server score already weights
 * quality and learned playback outcomes. Resolution never crosses a tier. A
 * working stream in the wrong language is still worse than a smaller correct one.
 */
export function rankSources(sources) {
  const tier = (s) => {
    const preferred = (s.languages || []).includes(PREFERRED_LANGUAGE);
    if (s.hybrid) return 0;
    if (preferred && s.selectableAudio) return 1;
    if (preferred) return 2;
    if (s.selectableAudio) return 3;
    return 4;
  };
  return [...sources].sort((a, b) => {
    // A row this browser cannot decode loses to every row it can, whatever
    // its tier: a black picture in the right language is not a result.
    const u = (a.unsupported ? 1 : 0) - (b.unsupported ? 1 : 0);
    if (u !== 0) return u;
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    // A progressive source has no ladder and no audio menu, so within a tier
    // it loses to an HLS one of the same height.
    const p = (a.progressive ? 1 : 0) - (b.progressive ? 1 : 0);
    if (p !== 0) return p;
    // Within a tier keep the server's order. The server ranks by learned
    // playback outcomes and already weights quality, so a client re-sort by
    // height would throw that learning away. Array sort is stable.
    return 0;
  });
}

export function endpoint(type, id, { season, episode, provider, refresh, capabilities, full } = {}) {
  // The backend's own route vocabulary is movie|series, not movie|tv.
  const kind = type === 'tv' || type === 'series' ? 'series' : 'movie';
  const qs = new URLSearchParams();
  if (season) qs.set('season', String(season));
  if (episode) qs.set('episode', String(episode));
  if (refresh) qs.set('refresh', '1');
  if (capabilities) qs.set('capabilities', '1');
  if (full) qs.set('full', '1');
  // The server skips APK-only providers (mapple, VaPlayer) for the web, so the
  // answer never waits on their timeouts (lib/routing/providerRoutes.js).
  qs.set('client', 'web');
  const q = qs.toString();
  const path = provider
    ? `/api/streams/${provider}/${kind}/${id}`
    : `/api/streams/${kind}/${id}`;
  return `${path}${q ? `?${q}` : ''}`;
}

/**
 * mapple and VaPlayer are APK-only (owner rule 2026-11-21). The server no longer
 * sends them to the web; this also drops them from an old or cached answer.
 */
const APK_ONLY = /^(mapple|vaplayer)\b/i;

/** Keep partial catalog coverage visible instead of turning it into a complete source list. */
export function sourcesFromResponse(d) {
  const pending = Boolean(d?.partial || d?.providerError)
    || (Array.isArray(d?.providerErrors) && d.providerErrors.some((p) => String(p).toLowerCase() === 'netmirror'));
  return rankSources((Array.isArray(d?.streams) ? d.streams : [])
    .filter((raw) => !APK_ONLY.test(String(raw?.provider || raw?.name || '').trim())).map((raw, i) => {
    const s = toSource(raw, i);
    return s && pending && String(s.provider).toLowerCase() === 'netmirror' ? { ...s, incomplete: true } : s;
  }).filter(Boolean));
}

/** Fetch and adapt every playable source for a title. */
export async function listSources(type, id, opts = {}) {
  try {
    const d = await getJson(endpoint(type, id, opts), opts);
    return sourcesFromResponse(d);
  } catch {
    return null; // null = "could not ask", [] = "asked, none exist"
  }
}

/**
 * Resolve with a progress log.
 *
 * The backend has no event feed, so the log is synthesised around the single
 * request. It is deliberately honest about that: it reports the request
 * starting and what came back, and never invents per-provider events it did
 * not observe. Inventing a plausible-looking "trying vaplayer…" for a provider
 * that was never contacted would be a lie the viewer cannot check.
 *
 * Signature matches Chitram's resolveStreamLive so useResolve is unchanged.
 * @returns {() => void} cancel
 */
export function resolveLive(type, id, {
  season = 0, episode = 0, provider = null, refresh = false,
  onEvent, onDone, onFail, onMore, clientFallback = null,
} = {}) {
  const ac = new AbortController();
  let settled = false;

  // The VM failed or had nothing: rows the browser can resolve itself
  // (lib/oneTouchClient.js) before the failure reaches the viewer. Rows come
  // in the server's shape, so they map exactly like server rows.
  const failOrFallback = (err) => {
    if (typeof clientFallback !== 'function') { onFail?.(err); return; }
    emit({ type: 'wave-start', providers: ['browser-side providers'] });
    Promise.resolve()
      .then(() => clientFallback(type, id, { season, episode, signal: ac.signal }))
      .then((rows) => {
        if (ac.signal.aborted) return;
        const sources = sourcesFromResponse({ streams: Array.isArray(rows) ? rows : [] });
        if (!sources.length) { onFail?.(err); return; }
        for (const p of new Set(sources.map((s) => s.provider))) emit({ type: 'extract-ok', provider: p, ms: 0 });
        onDone?.({ ...sources[0], sources });
      })
      .catch(() => { if (!ac.signal.aborted) onFail?.(err); });
  };

  const emit = (e) => { if (!settled && onEvent) onEvent({ ...e, at: Date.now() }); };

  // `provider` is the viewer's LAST-USED provider, remembered per title. It is
  // a PREFERENCE, not a filter.
  //
  // It used to be passed to the backend, which made the URL
  // /api/streams/CastleTV/movie/<id> - and that endpoint resolves ONLY that
  // provider. Measured on movie/256040: pinned returned 2 streams from 1
  // provider, the full fan-out returned 3 from 2. So every replay of a title
  // silently lost every other provider, including (on other titles) the
  // NetMirror master that carries the extra audio renditions. The Source list
  // then showed a single entry and the audio menu had nothing to offer.
  //
  // Fan out fully and let rankSources put the remembered one first.
  emit({ type: 'wave-start', providers: ['all enabled providers'] });

  const key = cacheKey(type, id, season, episode);
  const cached = refresh ? null : cacheGet(key);
  if (cached) emit({ type: 'cache-hit', provider: 'list from this session' });
  (cached ? Promise.resolve(cached)
    : refresh
      ? getJsonWithRetry(endpoint(type, id, { season, episode, provider: null, refresh }),
        { timeoutMs: 120000, signal: ac.signal }).then((d) => { cachePut(key, d); return d; })
      : fetchStreamsShared(key, endpoint(type, id, { season, episode })))
    .then((d) => {
      if (settled) return;
      let sources = sourcesFromResponse(d);
      // Honour the remembered provider by ORDER, now that it no longer
      // restricts the fan-out. Everything else keeps rankSources' ranking.
      // The remembered provider is a NAME, and a name no longer identifies a
      // row: measured on 811941 (Devara), CastleTV returns five rows and only
      // ONE is the demux master carrying the audio menu. Honouring the pin
      // must never promote a worse row of the same provider ahead of a better
      // one, or the language switcher silently disappears on replay - which is
      // exactly what a stale "CastleTV" pin did.
      //
      // So reorder by provider, but keep rankSources' order inside each half
      // AND never let the pin outrank a row that offers selectable audio.
      if (provider) {
        const want = String(provider).toLowerCase();
        const isWanted = (s) => String(s.provider).toLowerCase() === want;
        // Nor may it lift a row this browser cannot decode: those stay last.
        const best = sources.find((s) => s.selectableAudio && !s.unsupported) || null;
        const pinned = sources.filter((s) => isWanted(s) && s !== best && !s.unsupported);
        const rest = sources.filter((s) => !isWanted(s) && s !== best && !s.unsupported);
        const last = sources.filter((s) => s.unsupported);
        sources = [...(best ? [best] : []), ...pinned, ...rest, ...last];
      }

      // Report per provider from what actually came back. The backend also
      // returns providerTimings, so these numbers are measured, not guessed.
      const timings = d?.providerTimings || {};
      const seen = new Set();
      for (const s of sources) {
        const key = String(s.provider).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        emit({ type: 'extract-ok', provider: s.provider, ms: timings[key] ?? 0 });
      }
      for (const [name, ms] of Object.entries(timings)) {
        if (!seen.has(String(name).toLowerCase())) {
          emit({ type: 'extract-fail', provider: name, ms });
        }
      }

      settled = true;
      if (!sources.length) { failOrFallback(new Error('No playable source found.')); return; }
      onDone?.({ ...sources[0], sources });
      // A partial answer went out while slower providers were still running
      // (backend PRIMARY_PROVIDERS). Ask once more for the complete list; the
      // backend joins those running calls rather than starting them again.
      // The picture never waits for this: rows are merged as they land.
      // A provider that THREW (providerErrors) is asked again the same way:
      // the backend never memoizes such an answer, so ?full=1 re-runs it and
      // a wanted server gets its url instead of staying missing.
      const errored = Array.isArray(d?.providerErrors) && d.providerErrors.length > 0;
      if ((d?.partial || errored) && onMore) {
        getJson(endpoint(type, id, { season, episode, full: true }), { timeoutMs: 60000, signal: ac.signal })
          .then((full) => {
            if (ac.signal.aborted) return;
            cachePut(key, full);
            const more = sourcesFromResponse(full);
            if (more.length) onMore(more);
          })
          .catch(() => { /* the first list stands */ });
      }
    })
    .catch((err) => {
      if (settled || ac.signal.aborted) return;
      settled = true;
      failOrFallback(err);
    });

  return () => { settled = true; ac.abort(abortReason('resolve superseded or unmounted')); };
}

/**
 * URL handed to hls.js / <video>.
 *
 * Chitram wrapped every master in its resolver's `/api/m3u8?u=...` relay so the
 * server could attach the provider's Referer. This backend has already done
 * that: proxy/proxyServer.js rewrote each url to `/m3u8-proxy?url=...` (and
 * `/ts-proxy` for progressive files) before the browser ever saw it, and it
 * strips the upstream headers from the payload for the same reason.
 *
 * Wrapping again would produce `/api/m3u8?u=/m3u8-proxy?url=...` - a relay
 * pointed at a relay - so these are pass-throughs. They exist as functions so
 * useHls keeps its original shape.
 */
export function playableUrl(masterUrl) { return masterUrl; }

/**
 * Ask the backend to play one source's picture with another's audio.
 *
 * Called when the viewer has picked a language that does not exist inside the
 * video source they are watching. The backend applies its duration gate before
 * agreeing - two sources that disagree on runtime are very likely two
 * different films, since CastleTV matches by TITLE - so a 409 here means "this
 * combination is not real", not "the server failed".
 *
 * @returns {Promise<{url: string, delta: number, padded: boolean, codecs: ({video: string[], audio: string|null}|null)}|null>} null when
 * not pairable. `padded` true means the two halves are the same film but cut
 * with different ad/intro padding, so the automatic PTS probe cannot close the
 * gap and the viewer may need the Audio timing bar.
 */
export async function pairSources(video, audio, opts = {}) {
  if (!video?.masterUrl || !audio?.masterUrl) return null;
  // `codecs`: the CODECS the provider measured, so the server need not guess
  // them for an fMP4/HEVC source (docs/PENDING-WORK.md H6).
  const side = (s) => ({
    url: s.masterUrl, provider: s.provider, quality: s.quality,
    ...(s.codecString ? { codecs: s.codecString } : {}),
  });
  const body = { video: side(video), audio: side(audio) };
  // Which title this is, so the server can ask TMDB for the runtime.
  //
  // The runtime is what lets a PADDED source pair at all: without it the only
  // same-film test the server has is "the two sides agree on length", which
  // refuses a 2160p picture carrying an ad reel even when the audio beside it
  // is the only Telugu track on the title. Measured 2026-09-23 on movie/1290190
  // - mapple 9376s vs CastleTV 8974s, both within minutes of TMDB's 151min.
  //
  // Deliberately NOT sending headers alongside: the server resolved these urls
  // and already knows their headers first-hand (lib/media/streamHeaders.js).
  // Echoing them back from the browser would let a caller point our fetcher at
  // an arbitrary host with arbitrary headers.
  if (opts.tmdbId) {
    body.tmdbId = opts.tmdbId;
    body.type = opts.mediaType === 'tv' || opts.mediaType === 'series' ? 'series' : 'movie';
  }
  // A manual offset from the Audio timing bar, ADDED to whatever the automatic
  // PTS probe works out. Positive means the viewer wants the audio later.
  if (Number(opts.nudge)) body.nudge = Number(opts.nudge);
  // Step 2: the language the viewer asked to add. The server answers 409
  // 'not pairable' when the donor does not carry it (null here).
  if (opts.language) body.language = opts.language;
  try {
    const r = await fetch(`${BASE}/hybrid/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.url ? d : null;
  } catch {
    return null;
  }
}
export function proxiedSegment(url) { return url; }
