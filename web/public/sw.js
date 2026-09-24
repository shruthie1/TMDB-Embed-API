/*
 * Chitram service worker — app shell only.
 *
 * The ONE rule this file exists to enforce: video never touches the cache.
 *
 * Segments are up to 16MB each and arrive behind signed URLs that expire, so
 * caching them is wrong twice over — it would blow the origin's storage quota
 * within a single film, and every hit afterwards would replay a URL the CDN has
 * already stopped honouring. A stale 403 served from cache is worse than no
 * cache at all, because the player cannot tell it apart from a real failure.
 *
 * So the fetch handler is deny-by-default for anything that smells like media
 * or an API call, and only ever caches the static app shell: the build's
 * immutable /_next/static chunks, CSS, icons and fonts.
 *
 * Kept dependency-free and in plain script form (not a module) because it is
 * served verbatim from /public and must parse on older TV browsers too.
 */

/* eslint-env serviceworker */

// Bump when a UI shell change must invalidate an already-installed PWA.
const VERSION = 'chitram-v3';
const SHELL_CACHE = `${VERSION}-shell`;

/*
 * Paths that must NEVER be intercepted or cached.
 *
 * Every one of these is either a signed/expiring URL, a large media body, or a
 * personalised API response whose staleness would be invisible to the user.
 */
const BYPASS_PATH_PREFIXES = [
  '/api/seg',        // HLS segment relay — up to 16MB a piece
  '/api/m3u8',       // playlists; rewritten per-resolve, expire with the stream
  '/api/resolve/',   // resolve + progress streams (SSE, must not be replayed)
];

/* Media containers and segment/manifest extensions, matched on the path. */
const BYPASS_EXTENSIONS = /\.(ts|m4s|mp4|m3u8|mpd|webm|mkv|m4a|aac|vtt|srt|key)(\?|$)/i;

/**
 * Should this request be left entirely alone by the service worker?
 *
 * Exported onto self so the test suite can drive the real rule rather than a
 * copy of it — a second implementation in the tests would be free to drift
 * from this one, which is exactly the bug the tests are meant to catch.
 *
 * @param {string} url  absolute request URL
 * @param {string} [method]
 * @returns {boolean} true when the SW must not cache or intercept
 */
function shouldBypass(url, method = 'GET') {
  // Only ever handle simple reads. A POST/PUT is never shell.
  if (method !== 'GET') return true;

  let u;
  try {
    u = new URL(url);
  } catch {
    return true; // unparseable: do not touch it
  }

  // Cross-origin (TMDB art, Google Fonts CSS, CDN media) is not ours to cache
  // here; the shell cache is same-origin only.
  if (u.origin !== self.location.origin) return true;

  // Range requests are how a player seeks. Serving a cached 200 in place of a
  // 206 breaks playback outright.
  if (BYPASS_PATH_PREFIXES.some((p) => u.pathname.startsWith(p))) return true;
  if (BYPASS_EXTENSIONS.test(u.pathname)) return true;

  // Everything else under /api is dynamic catalogue data — safe to leave to
  // the network, and wrong to serve stale.
  if (u.pathname.startsWith('/api/')) return true;

  return false;
}

/** Is this a fingerprinted, immutable build asset or a static icon/font? */
function isShellAsset(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.pathname.startsWith('/_next/static/')) return true;
  if (u.pathname.startsWith('/icons/')) return true;
  return /\.(css|woff2?|png|svg|ico|webmanifest)(\?|$)/i.test(u.pathname);
}

self.shouldBypass = shouldBypass;
self.isShellAsset = isShellAsset;

self.addEventListener('install', (event) => {
  // Precache nothing: the chunk names are build-specific and unknown here.
  // The shell fills in on first navigation instead, which also keeps install
  // from failing on a flaky connection.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Leave the event untouched — no respondWith — so the browser performs its
  // own default fetch. This is what keeps range requests and SSE intact.
  if (shouldBypass(request.url, request.method)) return;
  if (request.headers && request.headers.get && request.headers.get('range')) return;

  if (!isShellAsset(request.url)) return;

  // Network-first keeps a new deployment visible immediately. The cache is
  // only the offline fallback; serving an old chunk first made installed PWAs
  // show a previous UI until a second reload.
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      try {
        const response = await fetch(request);
        if (response && response.ok && response.status === 200) {
          cache.put(request, response.clone()).catch(() => {});
        }
        return response;
      } catch {
        return cached;
      }
    })(),
  );
});
