import { deadKey, nextAlive } from './deadSources';
import { PREFERRED_LANGUAGE } from '../backend';
import { planPlayUrl } from './directRoute';

/**
 * Warm the next 2-3 servers while the current one plays.
 *
 * A server switch is slow mostly because everything is cold: the proxy has to
 * fetch the provider's master, a media playlist and the first segment before
 * hls.js can decode a frame. The proxy keeps segments (proxy/proxyServer.js
 * segment cache), so asking for them in the background, through the SAME urls
 * the player would use, makes a later switch hit warm data.
 *
 * Owner decisions 2026-11-20: warm 2-3 sources, not 1. Never during the first
 * 10s of playback. Low priority, one request at a time, cancellable. Skipped
 * when the browser says the link is metered (saveData) or 2G.
 *
 * Which sources: the ones auto-advance would pick, in that order (nextAlive,
 * same language first), so Telugu stays first here too.
 * Which segments: the ones at the CURRENT position, because a switch resumes
 * there, not at 0:00. Re-warmed every few minutes as the position moves.
 */
export const WARM_DELAY_MS = 10000;
export const WARM_MAX = 3;
export const WARM_SEGMENTS = 2;
export const REWARM_MS = 5 * 60 * 1000;

/** False on a link the browser marks as metered or very slow. */
export function warmAllowed(conn = globalThis.navigator?.connection) {
  if (!conn) return true;
  if (conn.saveData) return false;
  return !['slow-2g', '2g'].includes(String(conn.effectiveType || '').toLowerCase());
}

/** The top `max` alternates, in the order auto-advance would try them. */
export function warmCandidates(sources = [], { currentId = null, dead = new Set(), lang = null, height = null, max = WARM_MAX } = {}) {
  const skip = new Set(dead);
  if (currentId != null) skip.add(currentId);
  const playable = (sources || []).filter((s) => s?.masterUrl && !s.progressive);
  const out = [];
  while (out.length < Math.min(max, WARM_MAX)) {
    const next = nextAlive(playable, skip, { lang: lang || PREFERRED_LANGUAGE, height });
    if (!next) break;
    out.push(next);
    skip.add(deadKey(next));
  }
  return out;
}

const abs = (u, base) => { try { return new URL(u, base).href; } catch { return null; } };

/** Just enough of an m3u8 to find a variant, an init segment and segments. */
export function parsePlaylist(text = '', base = '') {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const segments = [];
  let init = null;
  let byteRange = false;
  let pendingVariant = null;
  let pendingDur = null;
  for (const l of lines) {
    if (!l) continue;
    if (l.startsWith('#EXT-X-STREAM-INF')) {
      const h = l.match(/RESOLUTION=\d+x(\d+)/i);
      const bw = l.match(/[:,]BANDWIDTH=(\d+)/i);
      pendingVariant = { height: h ? Number(h[1]) : null, bandwidth: bw ? Number(bw[1]) : 0 };
    } else if (l.startsWith('#EXT-X-MAP')) {
      const m = l.match(/URI="([^"]+)"/);
      if (m) init = abs(m[1], base);
    } else if (l.startsWith('#EXT-X-BYTERANGE')) {
      byteRange = true;
    } else if (l.startsWith('#EXTINF')) {
      const m = l.match(/#EXTINF:([\d.]+)/);
      pendingDur = m ? Number(m[1]) : 0;
    } else if (!l.startsWith('#')) {
      const url = abs(l, base);
      if (!url) continue;
      if (pendingVariant) { variants.push({ ...pendingVariant, url }); pendingVariant = null; }
      else if (pendingDur != null) { segments.push({ url, duration: pendingDur }); pendingDur = null; }
    }
  }
  return { variants, segments, init, byteRange };
}

/** The variant nearest the height playing now; the first listed when unknown. */
export function pickVariant(variants = [], height = null) {
  if (!variants.length) return null;
  if (!height) return variants[0];
  return [...variants].sort((a, b) =>
    Math.abs((a.height || 0) - height) - Math.abs((b.height || 0) - height))[0];
}

/** Index of the segment that covers `at` seconds. */
export function segmentIndexAt(segments = [], at = 0) {
  let t = 0;
  for (let i = 0; i < segments.length; i++) {
    t += segments[i].duration || 0;
    if (t > at) return i;
  }
  return Math.max(0, segments.length - 1);
}

async function get(fetchImpl, url, signal, asText) {
  const res = await fetchImpl(url, { signal, credentials: 'omit', priority: 'low' });
  if (!res?.ok) throw new Error(`warm ${res?.status}`);
  // Read the body to the end: the proxy caches a segment only once it has
  // all of it.
  return asText ? res.text() : res.arrayBuffer();
}

/**
 * Master, one media playlist, the init segment, and WARM_SEGMENTS segments at
 * `at`. Resolves to the list of urls fetched. Throws on abort.
 */
export async function warmSource(src, { at = 0, height = null, signal, fetchImpl = globalThis.fetch } = {}) {
  const fetched = [];
  // The url the player will play: direct for a web-direct row that has not
  // failed direct, else the proxy (same decision as useHls).
  let url = planPlayUrl(src).url;
  let pl = parsePlaylist(await get(fetchImpl, url, signal, true), url);
  fetched.push(url);
  if (pl.variants.length) {
    url = pickVariant(pl.variants, height).url;
    pl = parsePlaylist(await get(fetchImpl, url, signal, true), url);
    fetched.push(url);
  }
  // A byte-range playlist names one file many times; warming it by url would
  // pull the whole file.
  if (pl.byteRange || !pl.segments.length) return fetched;
  if (pl.init) { await get(fetchImpl, pl.init, signal, false); fetched.push(pl.init); }
  const i = segmentIndexAt(pl.segments, at);
  for (const seg of pl.segments.slice(i, i + WARM_SEGMENTS)) {
    await get(fetchImpl, seg.url, signal, false);
    fetched.push(seg.url);
  }
  return fetched;
}

/**
 * The timer half. `getState()` is read when the timer fires, so it sees the
 * position and the dead list of that moment:
 *   { sources, currentId, dead, lang, height, at, stable }
 * `stable` false (paused, buffering, a switch in flight) pushes the round back
 * by another delay instead of warming.
 *
 * start() (re)arms the delay and aborts anything in flight; stop() cancels
 * the timer and aborts the in-flight request. Sources are warmed one after
 * another, never in parallel, so playback keeps the bandwidth.
 */
export function createWarmScheduler({
  getState, fetchImpl = (...a) => globalThis.fetch(...a), delayMs = WARM_DELAY_MS,
  rewarmMs = REWARM_MS, max = WARM_MAX, allowed = warmAllowed, onWarm = null,
} = {}) {
  let timer = null;
  let ac = null;
  let gen = 0;

  const stop = () => {
    gen++;
    clearTimeout(timer);
    timer = null;
    if (ac) { try { ac.abort(); } catch { /* already done */ } }
    ac = null;
  };

  const arm = (ms, g) => {
    clearTimeout(timer);
    timer = setTimeout(() => round(g), ms);
  };

  async function round(g) {
    timer = null;
    if (g !== gen) return;
    if (!allowed()) return;
    const s = getState?.() || {};
    if (!s.stable) { arm(delayMs, g); return; }
    const picks = warmCandidates(s.sources, { ...s, max });
    if (!picks.length) return;
    ac = new AbortController();
    const { signal } = ac;
    for (const src of picks) {
      if (g !== gen) return;
      try {
        const urls = await warmSource(src, { at: s.at, height: s.height, signal, fetchImpl });
        onWarm?.(src, urls);
      } catch {
        if (g !== gen || signal.aborted) return;
        // One server failing to warm says nothing about the next one.
      }
    }
    if (g === gen) { ac = null; arm(rewarmMs, g); }
  }

  const start = () => {
    stop();
    arm(delayMs, gen);
  };

  return { start, stop, isArmed: () => timer != null || ac != null };
}
