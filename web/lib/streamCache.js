'use client';

/**
 * Client stream cache (P15, web port of the APK's StreamCache.kt).
 *
 * One entry per title, key `movie|tv:<id>:<season>:<episode>`. Inside a title,
 * one slot per source of rows:
 *   vm               the /api/streams answer (complete answers only)
 *   vm:<provider>    a per-provider answer (the NetMirror lookup)
 *   c:<provider>     rows resolved in this browser (OneTouchTV)
 *
 * A slot lives 30 min, cut short by the earliest URL expiry among its rows
 * (lib/urlExpiry.js, minus 30 s). At most 50 titles; the oldest write goes
 * first. Memory first, mirrored to localStorage so a reload keeps the rows.
 * Every storage access is wrapped: private mode or a full quota only costs the
 * persistence, never playback.
 *
 * A playback failure drops the whole title (dropTitle), so the next resolve is
 * fresh. "Refresh sources" drops it too.
 */
import { cappedTtlMs } from './urlExpiry';

export const STREAM_CACHE_TTL_MS = 30 * 60 * 1000;
export const STREAM_CACHE_MAX_TITLES = 50;
/**
 * A partial answer (a provider still running or failed, an incomplete row) is
 * kept this long, APK parity 2026-11-22: a second Play starts at once on its
 * rows. A complete answer replaces it (lib/backend.js keepStreamsAnswer).
 */
export const PARTIAL_CACHE_TTL_MS = 5 * 60 * 1000;
const STORE_KEY = 'chitram:streamCache:v1';

/** @type {Map<string, {w: number, slots: Record<string, {until: number, value: any}>}> | null} */
let mem = null;

export function titleKey(type, id, season = 0, episode = 0) {
  const kind = type === 'tv' || type === 'series' ? 'tv' : 'movie';
  return `${kind}:${id}:${season || 0}:${episode || 0}`;
}

function log(line) {
  try { console.info(line); } catch { /* logging never breaks playback */ }
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function load(now) {
  if (mem) return mem;
  mem = new Map();
  try {
    const raw = storage()?.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    for (const [k, e] of Array.isArray(list) ? list : []) {
      if (!e || typeof e !== 'object' || !e.slots) continue;
      mem.set(k, e);
    }
  } catch { /* unreadable: start empty */ }
  prune(now);
  return mem;
}

function prune(now) {
  for (const [k, e] of mem) {
    for (const [s, v] of Object.entries(e.slots)) if (!(now < v.until)) delete e.slots[s];
    if (!Object.keys(e.slots).length) mem.delete(k);
  }
}

function persist() {
  const st = storage();
  if (!st) return;
  try { st.setItem(STORE_KEY, JSON.stringify([...mem])); return; } catch { /* quota: try the newest half */ }
  // Memory stays whole: only the persisted copy is trimmed.
  try {
    const newest = [...mem.entries()].sort((a, b) => b[1].w - a[1].w);
    st.setItem(STORE_KEY, JSON.stringify(newest.slice(0, Math.floor(newest.length / 2))));
  } catch { /* memory cache still works */ }
}

/** Rows whose URLs bound the slot's life: `url` and the web-direct url. */
function urlsOf(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.streams) ? value.streams : [];
  const out = [];
  for (const r of rows) {
    if (typeof r?.url === 'string') out.push({ url: r.url });
    if (typeof r?.directUrl === 'string') out.push({ url: r.directUrl });
  }
  return out;
}

/** The stored value, or null. Logs `[cache] hit|miss <key>#<slot>`. */
export function getSlot(key, slot, now = Date.now()) {
  const e = load(now).get(key);
  const v = e?.slots?.[slot];
  if (v && now < v.until) { log(`[cache] hit ${key}#${slot}`); return v.value; }
  if (v) { delete e.slots[slot]; if (!Object.keys(e.slots).length) mem.delete(key); persist(); }
  log(`[cache] miss ${key}#${slot}`);
  return null;
}

/** True when a live value exists. Silent: for prewarm decisions. */
export function hasSlot(key, slot, now = Date.now()) {
  const v = load(now).get(key)?.slots?.[slot];
  return Boolean(v && now < v.until);
}

/** The live value, or null. Silent and side-effect free: for write decisions. */
export function peekSlot(key, slot, now = Date.now()) {
  const v = load(now).get(key)?.slots?.[slot];
  return v && now < v.until ? v.value : null;
}

/**
 * Store a value. Returns false when its URLs are already (nearly) dead.
 * `maxTtlMs` shortens the life (a partial answer: PARTIAL_CACHE_TTL_MS).
 */
export function putSlot(key, slot, value, now = Date.now(), { maxTtlMs = STREAM_CACHE_TTL_MS } = {}) {
  const ttl = cappedTtlMs(Math.min(STREAM_CACHE_TTL_MS, maxTtlMs), urlsOf(value), undefined, now);
  if (!(ttl > 0)) { log(`[cache] skip ${key}#${slot} url-expiry`); return false; }
  const m = load(now);
  const e = m.get(key) || { w: now, slots: {} };
  e.w = now;
  e.slots[slot] = { until: now + ttl, value };
  m.delete(key); m.set(key, e);
  prune(now);
  while (m.size > STREAM_CACHE_MAX_TITLES) {
    let oldest = null;
    for (const [k, x] of m) if (!oldest || x.w < m.get(oldest).w) oldest = k;
    m.delete(oldest);
  }
  persist();
  return true;
}

export function dropSlot(key, slot) {
  const e = load(Date.now()).get(key);
  if (!e?.slots?.[slot]) return;
  delete e.slots[slot];
  if (!Object.keys(e.slots).length) mem.delete(key);
  persist();
}

/** Drop every slot of a title (a failed row, or Refresh sources). */
export function dropTitle(key, why = '') {
  const had = load(Date.now()).delete(key);
  if (had) { log(`[cache] drop ${key}${why ? ` reason=${why}` : ''}`); persist(); }
}

/** Test hook: forget memory so the next read reloads from storage. */
export function _resetStreamCache({ clearStorage = true } = {}) {
  mem = null;
  if (clearStorage) { try { storage()?.removeItem(STORE_KEY); } catch { /* none */ } }
}
