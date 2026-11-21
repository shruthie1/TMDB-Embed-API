/*
 * Chitram service worker: app shell, artwork and catalogue cache.
 *
 * The ONE rule this file exists to enforce: video and stream resolution never
 * touch the cache.
 *
 * Segments are up to 16MB each and arrive behind signed URLs that expire, so
 * caching them is wrong twice over: it would blow the origin's storage quota
 * within a single film, and every hit afterwards would replay a URL the CDN has
 * already stopped honouring. A stale 403 served from cache is worse than no
 * cache at all, because the player cannot tell it apart from a real failure.
 * Resolve and /api/streams answers carry the same expiring URLs, so they are
 * excluded by name as well.
 *
 * Everything is deny-by-default. A request is only handled when it matches one
 * of four explicit classes:
 *
 *   static   /_next/static/*        immutable, content-hashed: cache-first
 *   asset    icons, svg, css, fonts  stale-while-revalidate
 *   image    TMDB / Amazon artwork   cache-first, 30 day TTL, size-capped
 *   catalog  rows, title, season...  stale-while-revalidate, fresh for 1 hour
 *   navigate page HTML               network-first, cache only as offline fallback
 *
 * Network-first HTML is what keeps a deploy visible at once: the page always
 * comes from the server when it is reachable, and it names the new chunk
 * hashes, which are then fetched (they are not in the cache yet).
 *
 * Kept dependency-free and in plain script form (not a module) because it is
 * served verbatim from /public and must parse on older TV browsers too. No
 * optional chaining or nullish coalescing for the same reason.
 */

/* eslint-env serviceworker */

// Bump when a UI shell change must invalidate an already-installed PWA.
const VERSION = 'chitram-v4';
const SHELL_CACHE = VERSION + '-shell';
// Artwork and catalogue survive a shell bump: a poster never changes for a
// title, and catalogue entries carry their own age. Bump these suffixes only
// when the stored format changes.
const IMAGE_CACHE = 'chitram-img-v1';
const API_CACHE = 'chitram-api-v1';
const KEEP_CACHES = [SHELL_CACHE, IMAGE_CACHE, API_CACHE];

// TMDB image paths are content-addressed (hash filenames), so a stored poster
// never goes stale: keep many, for a long time. w185/w342 are ~10-40KB each.
const IMAGE_MAX_ENTRIES = 1500;
const IMAGE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const API_MAX_ENTRIES = 200;
const API_FRESH_MS = 60 * 60 * 1000;          // serve without a refresh
const API_MAX_STALE_MS = 24 * 60 * 60 * 1000; // older than this: network first
const SHELL_MAX_ENTRIES = 250;

const STAMP = 'x-sw-cached-at';

/*
 * Paths that must NEVER be intercepted or cached, on any origin.
 *
 * Every one of these is either a signed/expiring URL, a large media body, a
 * stream resolution, or an operator surface. Checked before anything else, so
 * a later allowlist cannot widen past them.
 */
const BYPASS_PATH_PREFIXES = [
  '/api/seg',          // HLS segment relay, up to 16MB a piece
  '/api/m3u8',         // playlists; rewritten per-resolve, expire with the stream
  '/api/resolve',      // resolve + progress streams (SSE, must not be replayed)
  '/api/streams',      // Express stream resolution: expiring CDN urls
  '/api/providers',    // operator: provider list, tests, mutations
  '/api/capabilities', // backend feature probe
  '/api/status',
  '/api/health',
  '/api/playback',
  '/api/vm',
  '/api/lab',
  '/api/cron',
  '/m3u8-proxy',       // Express playlist relay
  '/ts-proxy',         // Express segment relay
  '/hybrid',           // fused video+audio masters
  '/pts-rebase',
  '/castle-demux',
  '/stats',            // operator pages (cookie-gated)
  '/providers',
  '/lab',
];

/* Media containers and segment/manifest extensions, matched on the path. */
const BYPASS_EXTENSIONS = /\.(ts|m4s|mp4|m3u8|mpd|webm|mkv|m4a|aac|vtt|srt|key)(\?|$)/i;

/*
 * Artwork hosts the SW may cache. Both send `access-control-allow-origin: *`
 * to a request that carries Origin (checked 2026-11-21; tmdb omits it for a
 * plain <img> request), so the SW refetches in CORS mode and stores a real,
 * readable response. images.metahub.space sends no CORS header: its response
 * would be opaque, which Chrome pads to ~7MB of quota each, so it is left to
 * the browser's HTTP cache (it sends max-age=5184000).
 */
const IMAGE_HOSTS = ['image.tmdb.org', 'm.media-amazon.com'];

/*
 * Catalogue routes cached for an hour. An allowlist of exact shapes, so a new
 * route under /api (say /api/title/x/y/resolve) is not cached by accident.
 * /api/search stays on the network: typed queries rarely repeat.
 */
const CATALOG_PATTERNS = [
  /^\/api\/rows\/[^/]+$/,
  /^\/api\/title\/[^/]+\/[^/]+(\/full)?$/,
  /^\/api\/season\/[^/]+\/[^/]+$/,
  /^\/api\/similar\/[^/]+\/[^/]+$/,
  /^\/api\/person\/[^/]+$/,
  /^\/api\/discover$/,
];

function parse(url) {
  try {
    return new URL(url);
  } catch (e) {
    return null;
  }
}

function hasBypassPrefix(pathname) {
  return BYPASS_PATH_PREFIXES.some(function (p) {
    return pathname === p || pathname.startsWith(p + '/')
      || (p.startsWith('/api/') && pathname.startsWith(p));
  });
}

function isCatalog(u) {
  return u.origin === self.location.origin
    && CATALOG_PATTERNS.some(function (re) { return re.test(u.pathname); });
}

function isImage(u) {
  return u.protocol === 'https:' && IMAGE_HOSTS.indexOf(u.hostname) !== -1;
}

/**
 * Should this request be left entirely alone by the service worker?
 *
 * Exported onto self so the test suite can drive the real rule rather than a
 * copy of it: a second implementation in the tests would be free to drift
 * from this one, which is exactly the bug the tests are meant to catch.
 *
 * @param {string} url  absolute request URL
 * @param {string} [method]
 * @returns {boolean} true when the SW must not cache or intercept
 */
function shouldBypass(url, method) {
  // Only ever handle simple reads. A POST/PUT is never cached.
  if ((method || 'GET') !== 'GET') return true;

  const u = parse(url);
  if (!u) return true; // unparseable: do not touch it

  // Stream, media and operator paths: never, on any origin.
  if (hasBypassPrefix(u.pathname)) return true;
  if (BYPASS_EXTENSIONS.test(u.pathname)) return true;

  // Cross-origin: only the listed artwork hosts.
  if (u.origin !== self.location.origin) return !isImage(u);

  // App Router flight data for client-side navigation. Tied to a build and
  // to router state; Next manages it itself.
  if (u.searchParams.has('_rsc')) return true;

  // Under /api only the catalogue allowlist is handled. Everything else, and
  // anything unknown, goes to the network.
  if (u.pathname.startsWith('/api/')) return !isCatalog(u);

  return false;
}

/** Is this a fingerprinted, immutable build asset or a static icon/font? */
function isShellAsset(url) {
  const u = parse(url);
  if (!u || u.origin !== self.location.origin) return false;
  if (u.pathname.startsWith('/_next/static/')) return true;
  if (u.pathname.startsWith('/icons/')) return true;
  return /\.(css|woff2?|png|svg|ico|webmanifest)(\?|$)/i.test(u.pathname);
}

/**
 * Which strategy handles this request, or 'bypass'.
 *
 * @param {string} url
 * @param {string} [method]
 * @param {string} [mode]  Request.mode; 'navigate' for a page load
 * @returns {'bypass'|'static'|'asset'|'image'|'catalog'|'navigate'}
 */
function classify(url, method, mode) {
  if (shouldBypass(url, method)) return 'bypass';
  const u = parse(url);
  if (u.origin !== self.location.origin) return 'image';
  if (isCatalog(u)) return 'catalog';
  if (u.pathname.startsWith('/_next/static/')) return 'static';
  if (isShellAsset(url)) return 'asset';
  if (mode === 'navigate') return 'navigate';
  return 'bypass';
}

self.shouldBypass = shouldBypass;
self.isShellAsset = isShellAsset;
self.classify = classify;

/* ---------------------------------------------------------------- helpers */

/** A copy of `response` with the time it was stored, read back by ageOf(). */
async function stamped(response) {
  const headers = new Headers(response.headers);
  headers.set(STAMP, String(Date.now()));
  const body = await response.clone().blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers,
  });
}

function ageOf(response) {
  const at = Number(response.headers.get(STAMP));
  return at > 0 ? Date.now() - at : Infinity;
}

function cacheable(response) {
  if (!response || response.status !== 200) return false;
  const cc = response.headers.get('cache-control') || '';
  return !/no-store|private/i.test(cc);
}

/** Drop the oldest entries past `max`. keys() returns insertion order. */
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const extra = keys.length - max;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

async function store(cacheName, request, response, max) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, await stamped(response));
    if (max) await trim(cacheName, max);
  } catch (e) {
    /* quota or a body already read: the response was still served */
  }
}

/* -------------------------------------------------------------- strategies */

// Content-hashed chunks never change under the same name.
async function cacheFirstStatic(event) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const response = await fetch(event.request);
  if (cacheable(response)) {
    event.waitUntil(store(SHELL_CACHE, event.request, response.clone(), SHELL_MAX_ENTRIES));
  }
  return response;
}

// Icons and CSS without a hash: serve at once, refresh for the next visit.
async function staleWhileRevalidateAsset(event) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(event.request);
  const refresh = fetch(event.request).then(function (response) {
    if (cacheable(response)) {
      return store(SHELL_CACHE, event.request, response.clone(), SHELL_MAX_ENTRIES)
        .then(function () { return response; });
    }
    return response;
  });
  if (hit) {
    event.waitUntil(refresh.catch(function () {}));
    return hit;
  }
  return refresh;
}

// Artwork: cache-first for 30 days. The cache key is the plain URL so a
// no-cors <img> request and the CORS refetch share one entry.
async function cacheFirstImage(event) {
  const url = event.request.url;
  const cache = await caches.open(IMAGE_CACHE);
  const hit = await cache.match(url);
  if (hit && ageOf(hit) < IMAGE_TTL_MS) return hit;
  try {
    // Use the browser HTTP cache (no cache:'reload'). image.tmdb.org sends
    // cache-control max-age ~1 year AND access-control-allow-origin:* on every
    // response, Origin or not, so a CORS fetch served from the HTTP cache does
    // not fail. 'reload' forced the network on every Cache-API miss, which
    // blanked posters on low-memory TVs (an image evicted from memory re-hit
    // the network instead of the year-long HTTP cache). The CORS doubling the
    // old comment feared does not happen: the header is always present.
    const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (cacheable(response)) {
      event.waitUntil(store(IMAGE_CACHE, url, response.clone(), IMAGE_MAX_ENTRIES));
      return response;
    }
    if (hit) return hit;
    return response;
  } catch (e) {
    if (hit) return hit;
    // CORS refused or offline: let the browser try the original request.
    return fetch(event.request);
  }
}

// Catalogue: fresh for an hour; up to a day old is served at once and
// refreshed in the background; older than that waits for the network.
async function staleWhileRevalidateCatalog(event) {
  const request = event.request;
  const cache = await caches.open(API_CACHE);
  const hit = await cache.match(request);
  const age = hit ? ageOf(hit) : Infinity;

  if (hit && age < API_FRESH_MS) return hit;

  const refresh = fetch(request).then(function (response) {
    if (cacheable(response)) {
      return store(API_CACHE, request, response.clone(), API_MAX_ENTRIES)
        .then(function () { return response; });
    }
    return response;
  });

  if (hit && age < API_MAX_STALE_MS) {
    event.waitUntil(refresh.catch(function () {}));
    return hit;
  }
  try {
    return await refresh;
  } catch (e) {
    if (hit) return hit;
    throw e;
  }
}

// Pages: always the network when it answers, so a deploy shows on the next
// load. The stored copy is only for offline.
async function networkFirstPage(event) {
  const request = event.request;
  try {
    const response = await fetch(request);
    if (cacheable(response) && response.type === 'basic') {
      event.waitUntil(store(SHELL_CACHE, request.url, response.clone(), SHELL_MAX_ENTRIES));
    }
    return response;
  } catch (e) {
    const cache = await caches.open(SHELL_CACHE);
    const hit = (await cache.match(request.url)) || (await cache.match(self.location.origin + '/'));
    if (hit) return hit;
    throw e;
  }
}

/* ------------------------------------------------------------------ events */

/*
 * Precache the home page and the chunks it names, so a second visit can start
 * offline. Best effort: a failure here must not fail install, or the SW would
 * never activate on a flaky connection.
 */
async function precacheShell() {
  const root = self.location.origin + '/';
  const response = await fetch(root, { credentials: 'same-origin' });
  if (!cacheable(response)) return;
  const html = await response.clone().text();
  await store(SHELL_CACHE, root, response);
  const seen = {};
  const assets = [];
  const re = /\/_next\/static\/[^"'\s)\\]+/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!seen[m[0]]) { seen[m[0]] = true; assets.push(m[0]); }
  }
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(assets.map(function (path) {
    return cache.add(path).catch(function () {});
  }));
}

self.addEventListener('install', function (event) {
  event.waitUntil(precacheShell().catch(function () {}));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const names = await caches.keys();
      await Promise.all(
        names.filter(function (n) { return KEEP_CACHES.indexOf(n) === -1; })
          .map(function (n) { return caches.delete(n); }),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;

  // Leave the event untouched (no respondWith) so the browser performs its
  // own default fetch. This is what keeps range requests and SSE intact.
  if (request.headers && request.headers.get && request.headers.get('range')) return;

  const kind = classify(request.url, request.method, request.mode);
  if (kind === 'bypass') return;

  if (kind === 'static') event.respondWith(cacheFirstStatic(event));
  else if (kind === 'asset') event.respondWith(staleWhileRevalidateAsset(event));
  else if (kind === 'image') event.respondWith(cacheFirstImage(event));
  else if (kind === 'catalog') event.respondWith(staleWhileRevalidateCatalog(event));
  else if (kind === 'navigate') event.respondWith(networkFirstPage(event));
});
