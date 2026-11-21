/**
 * OneTouchTV resolved in the browser, for when the VM cannot answer.
 *
 * Port of providers/onetouchtv.js. Measured 2026-11-21 from a Jio IP with
 * `Origin: https://chtrm2.vercel.app` and no Referer: search, detail and
 * episode all 200 with `Access-Control-Allow-Origin: *`, and they need no
 * header a browser cannot send. The hitv.ltd stream CDN answers 200/206 to that
 * Origin as long as no Referer is sent; the page already sends none
 * (app/layout.jsx `<meta name="referrer" content="no-referrer">`).
 *
 * Rows come back in the server's /api/streams shape so sourcesFromResponse
 * maps them exactly like server rows. No language is claimed: the upstream has
 * no audio metadata (providers/onetouchtv.js).
 *
 * showsst is NOT here: its api answers 403 "forbidden" to any Origin but its
 * own player, and a browser cannot change Origin.
 */

const BASE = 'https://api3.devcorp.me';
const CINEMETA = 'https://v3-cinemeta.strem.io';
// Same fixed key/iv as the server (providers/onetouchtv.js).
const KEY = 'im72charPasswordofdInitVectorStm';
const IV = 'im72charPassword';
const STEP_TIMEOUT_MS = 15000;
const RETRIES = 2;

let keyPromise = null;
function aesKey() {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'AES-CBC' }, false, ['decrypt', 'encrypt']);
  }
  return keyPromise;
}

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** The server's decrypt: `-_.` to `/`, `@` to `+`, no whitespace, padded base64, AES-256-CBC. */
export async function decrypt(encoded) {
  let s = String(encoded).replace(/-_\./g, '/').replace(/@/g, '+').replace(/\s+/g, '');
  if (s.length % 4) s += '='.repeat(4 - (s.length % 4));
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new TextEncoder().encode(IV) }, await aesKey(), b64ToBytes(s));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Test helper: the inverse of decrypt in the upstream's alphabet. */
export async function encrypt(obj) {
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new TextEncoder().encode(IV) }, await aesKey(), new TextEncoder().encode(JSON.stringify(obj))));
  let bin = '';
  for (const b of c) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\//g, '-_.').replace(/\+/g, '@').replace(/=+$/, '');
}

// ---- title match: utils/titleMatch.js (findTitleMatch, searchSpellings) ----

const ORDINALS = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};
const SUFFIX_NOISE = /^(?:part|chapter|vol|volume|book|season|pt)?\s*\d*\s*$/;
const PART_SUFFIX = /^(?:part|chapter|vol|volume|book|season|pt)\s*([0-9]+|[a-z]+)\b(.*)$/;
const LANG_WORDS = 'hindi|telugu|tamil|malayalam|kannada|english|bengali|marathi'
  + '|punjabi|gujarati|urdu|odia|assamese|bhojpuri|dubbed|dub';
const EDITION_WORDS = 'reloaded|extended|uncut|remastered|restored|theatrical'
  + '|director\'s|directors|special|deluxe|final';
const LANGUAGE_TAG = new RegExp(
  '\\s*[\\(\\[]\\s*(?:' + LANG_WORDS + '|(?:[a-z\']+\\s+)?(?:' + EDITION_WORDS + ')'
  + '(?:\\s+(?:version|cut|edition))?|(?:' + EDITION_WORDS + ')?\\s*(?:version|cut|edition))'
  + '\\s*[\\)\\]]\\s*$|\\s*\\b(?:' + LANG_WORDS + ')\\s*$', 'i');
const LEADING_ARTICLE = /^(?:the|a|an)\s+/;

function partNumber(rest) {
  const m = String(rest || '').trim().match(PART_SUFFIX);
  if (!m) return null;
  if (/^[0-9]+$/.test(m[1])) return Number(m[1]);
  return Object.prototype.hasOwnProperty.call(ORDINALS, m[1]) ? ORDINALS[m[1]] : null;
}
function stripLanguageTag(value) {
  let out = String(value || '');
  let prev;
  do { prev = out; out = out.replace(LANGUAGE_TAG, '').trim(); } while (out !== prev);
  return out;
}
const deaccent = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '');
const normalizeTitle = (v) => deaccent(v).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const looseTitle = (v) => normalizeTitle(v).replace(/([aeiou])\1+/g, '$1');
const withoutArticle = (v) => String(v || '').replace(LEADING_ARTICLE, '').trim();
function isPrefixWithSuffixNoise(row, want) {
  if (!row || !want) return false;
  const [short, long] = row.length <= want.length ? [row, want] : [want, row];
  if (short.length < 4) return false;
  if (short === long) return true;
  if (!long.startsWith(`${short} `)) return false;
  const rest = long.slice(short.length).trim();
  return SUFFIX_NOISE.test(rest) || partNumber(rest) !== null;
}
function splitPart(value) {
  const v = String(value || '').trim();
  const m = v.match(/^(.*?)\s+((?:part|chapter|vol|volume|book|season|pt)\s+(?:[0-9]+|[a-z]+))(?:\s+.*)?$/);
  if (!m) return { base: v, part: null };
  const part = partNumber(m[2]);
  return part === null ? { base: v, part: null } : { base: m[1].trim(), part };
}
function samePart(a, b) {
  if (!a || !b) return false;
  const sa = splitPart(a); const sb = splitPart(b);
  if (sa.part === null || sb.part === null || sa.part !== sb.part) return false;
  if (!sa.base || sa.base.length < 4) return false;
  return sa.base === sb.base;
}
function conflictingParts(a, b) {
  const shorter = a.length <= b.length ? a : b;
  const pa = partNumber(a.startsWith(shorter) ? a.slice(shorter.length).trim() : '');
  const pb = partNumber(b.startsWith(shorter) ? b.slice(shorter.length).trim() : '');
  return pa !== null && pb !== null && pa !== pb;
}

/** providers/onetouchtv.js splitTitleYear: "RRR (2022)" -> { title: 'RRR', year: 2022 }. */
export function splitTitleYear(value) {
  const t = String(value || '');
  const m = /^(.*\S)\s+\((\d{4})\)\s*$/.exec(t);
  return m ? { title: m[1], year: parseInt(m[2], 10) } : { title: t, year: null };
}

/** utils/titleMatch.js findTitleMatch: rows are {title, year}. */
export function findTitleMatch(rows, title, year = null) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const want = normalizeTitle(title);
  if (!list.length || !want) return null;
  const wantLoose = looseTitle(title);
  const wantBare = withoutArticle(want);
  const yearOk = (r) => !year || !r.year || String(r.year) === String(year);
  const kept = list.filter(yearOk);
  const pool = kept.length ? kept : list;
  const rowNorm = (r) => normalizeTitle(stripLanguageTag(r.title || ''));
  const rowLoose = (r) => looseTitle(stripLanguageTag(r.title || ''));
  const passes = [
    (r) => rowNorm(r) === want,
    (r) => rowLoose(r) === wantLoose,
    (r) => withoutArticle(rowNorm(r)) === wantBare,
    (r) => samePart(rowNorm(r), want),
    (r) => !conflictingParts(rowNorm(r), want) && isPrefixWithSuffixNoise(rowNorm(r), want),
    (r) => !conflictingParts(rowLoose(r), wantLoose) && isPrefixWithSuffixNoise(rowLoose(r), wantLoose),
  ];
  for (const pass of passes) {
    const hit = pool.find(pass);
    if (hit) return hit;
  }
  return null;
}

/** utils/titleMatch.js searchSpellings(title) with its defaults (no year, head on). */
export function searchSpellings(title) {
  const raw = String(title || '').trim();
  if (!raw) return [];
  const out = [];
  const add = (v) => { const t = String(v || '').trim(); if (t && !out.includes(t)) out.push(t); };
  const plain = deaccent(raw);
  const depunct = (v) => String(v).replace(/[-–—:]/g, ' ').replace(/\s+/g, ' ').trim();
  add(raw); add(plain); add(depunct(raw)); add(depunct(plain));
  const headRaw = raw.split(/[:–—]/)[0].trim();
  const headPlain = deaccent(headRaw);
  add(depunct(headRaw)); add(headRaw); add(headPlain);
  if (headPlain && /^[a-z]+$/i.test(headPlain)) {
    const m = headPlain.match(/^([b-df-hj-np-tv-z]*)([aeiou])(.*)$/i);
    if (m) add(`${m[1]}${m[2]}${m[2]}${m[3]}`);
  }
  return out;
}

// ---- the chain ----------------------------------------------------------------

function resolveQuality(quality) {
  if (!quality) return 'Auto';
  const q = String(quality).toLowerCase();
  if (q === 'auto') return 'Auto';
  if (q.includes('2160') || q.includes('4k') || q.includes('uhd')) return '2160p';
  if (q.includes('1440')) return '1440p';
  if (q.includes('1080')) return '1080p';
  if (q.includes('720')) return '720p';
  if (q.includes('480')) return '480p';
  if (q.includes('360')) return '360p';
  return 'Auto';
}

function httpError(status, path) {
  const e = new Error(`HTTP ${status} from ${path}`);
  e.status = status;
  return e;
}

/**
 * Resolve one title's OneTouchTV rows in the browser.
 *
 * @param {object} o
 * @param {'movie'|'tv'} o.type
 * @param {number|string} o.tmdbId
 * @param {number} [o.season]
 * @param {number} [o.episode]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {AbortSignal} [o.signal]
 * @param {string} [o.base]   OneTouchTV api origin (tests)
 * @param {string} [o.cinemeta]
 * @param {number} [o.retryDelayMs]
 * @returns {Promise<object[]>} rows in the server's /api/streams shape; [] = not there.
 *   Throws when the upstream failed.
 */
export async function resolveOneTouchRows({
  type, tmdbId, season = 0, episode = 0, fetchImpl = (...a) => fetch(...a), signal,
  base = BASE, cinemeta = CINEMETA, retryDelayMs = 400,
} = {}) {
  const series = type === 'tv';
  const timed = () => {
    const t = AbortSignal.timeout(STEP_TIMEOUT_MS);
    return signal && AbortSignal.any ? AbortSignal.any([signal, t]) : (signal || t);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const call = async (path) => {
    let last;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        const res = await fetchImpl(`${base}${path}`, { signal: timed(), referrerPolicy: 'no-referrer', credentials: 'omit' });
        if (!res.ok) throw httpError(res.status, path);
        return (await decrypt(await res.text())).result;
      } catch (err) {
        last = err;
        if (signal?.aborted) throw err;
        if (err && err.status !== undefined && err.status < 500) break;
        if (attempt < RETRIES) await sleep(retryDelayMs * (attempt + 1));
      }
    }
    throw last;
  };
  const sameOrigin = async (path) => {
    const res = await fetchImpl(path, { signal: timed() });
    if (!res.ok) throw httpError(res.status, path);
    return res.json();
  };

  // Title, year and imdb id from this app's own catalog route (Vercel, not the VM).
  const meta = await sameOrigin(`/api/title/${series ? 'tv' : 'movie'}/${encodeURIComponent(tmdbId)}/full`);
  const title = (meta && meta.title) || '';
  const year = (meta && meta.year) || null;
  const imdbId = meta && typeof meta.imdbId === 'string' && meta.imdbId.startsWith('tt') ? meta.imdbId : null;
  if (!title) return [];

  const s = Number(season) || 1;
  const e = Number(episode) || 1;
  const keywords = searchSpellings(title);
  if (series && s > 1) keywords.unshift(`${title} Season ${s}`);

  const allowed = series ? new Set(['drama', 'variety', 'anime']) : new Set(['movie']);
  let match = null;
  for (const kw of keywords) {
    let rows;
    try {
      rows = await call(`/vod/search?keyword=${encodeURIComponent(kw)}`);
    } catch (err) {
      if (err && err.status === 404) continue; // "no such keyword"
      throw err;
    }
    const typed = (Array.isArray(rows) ? rows : [])
      .filter((r) => r && allowed.has(String(r.type || '').toLowerCase()))
      .map((r) => ({ r, split: splitTitleYear(r.title) }))
      // "RRR (2022)": a stated title year more than one off the wanted year rejects the row.
      .filter(({ split }) => !split.year || !year || Math.abs(split.year - Number(year)) <= 1)
      .map(({ r, split }) => ({ title: split.title, year: parseInt(r.year, 10) || undefined, raw: r }));
    const searchYear = kw !== title && s > 1 ? null : year;
    match = findTitleMatch(typed, kw, searchYear);
    if (match) break;
  }
  if (!match) return [];

  // The server's IMDB cross-check (utils/tmdbTitleToImdb.js), on TMDB ids via
  // this app's /api/search. Inconclusive never rejects.
  try {
    const found = await sameOrigin(`/api/search?q=${encodeURIComponent(match.title)}`);
    const rows = (Array.isArray(found?.titles) ? found.titles : [])
      .filter((r) => (r.mediaType === 'tv') === series)
      .map((r) => ({ title: r.title, year: r.year, tmdbId: r.tmdbId }));
    const hit = findTitleMatch(rows, match.title, match.year || splitTitleYear(match.raw.title).year || null);
    if (hit && String(hit.tmdbId) !== String(tmdbId)) return [];
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  const detail = await call(`/vod/${match.raw.id}/detail`);
  const episodes = Array.isArray(detail?.episodes) ? detail.episodes : [];
  if (!episodes.length) return [];

  let target = null;
  const epNum = (x) => parseInt(x.episode, 10);
  if (!series) target = episodes[0];
  else {
    const named = /\bseason\s+(\d+)\b/i.exec(match.raw.title);
    if (s > 1 && named && parseInt(named[1], 10) !== s) return [];
    if (s === 1 || new RegExp(`\\bseason\\s+${s}\\b`, 'i').test(match.raw.title)) {
      target = episodes.find((x) => epNum(x) === e) || null;
    } else if (imdbId) {
      const abs = await absoluteEpisode(imdbId, s, e);
      if (abs !== null) target = episodes.find((x) => epNum(x) === abs) || null;
    }
  }
  if (!target) return [];

  const data = await call(`/vod/${match.raw.id}/episode/${target.playId}`);
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const subtitles = (Array.isArray(data?.track) ? data.track : [])
    .filter((t) => t && t.file && t.name).map((t) => ({ url: t.file, lang: t.name }));
  const seen = new Set();
  const out = [];
  for (const src of sources) {
    if (!src || !src.url || seen.has(src.url)) continue;
    seen.add(src.url);
    const quality = resolveQuality(src.quality);
    const container = String(src.type || 'hls').toLowerCase() === 'hls' ? 'hls' : (src.type || null);
    out.push({
      name: `OneTouchTV${src.name ? ` | ${src.name}` : ''}`,
      title: `${match.raw.title}\n${quality} · ${String(src.type ?? 'HLS').toUpperCase()}`,
      url: src.url,
      // Played straight from the CDN: there is no proxy to fall back to here.
      directUrl: src.url,
      route: { web: 'direct' },
      quality,
      provider: 'OneTouchTV',
      container,
      languages: [],
      audio: [],
      size: null,
      clientResolved: true,
      ...(subtitles.length ? { subtitles } : {}),
    });
  }
  return out;

  async function absoluteEpisode(imdb, season2, ep) {
    try {
      const res = await fetchImpl(`${cinemeta}/meta/series/${imdb}.json`, { signal: timed(), referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (!res.ok) return null;
      const videos = (await res.json())?.meta?.videos || [];
      const max = new Map();
      for (const v of videos) {
        if (!v.season || v.season <= 0) continue;
        const n = v.number || v.episode || 0;
        if (n > 0) max.set(v.season, Math.max(max.get(v.season) || 0, n));
      }
      let offset = 0;
      for (let k = 1; k < season2; k += 1) {
        const c = max.get(k) || 0;
        if (!c) return null;
        offset += c;
      }
      return offset + ep;
    } catch {
      return null;
    }
  }
}
