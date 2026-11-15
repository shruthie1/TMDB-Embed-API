import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import manifest from '../app/manifest.js';

const root = resolve(__dirname, '..');

/**
 * Load the REAL public/sw.js and pull its rules out.
 *
 * Deliberately not a re-implementation: the whole point of these tests is to
 * catch the shipped file losing its bypass, and a copied predicate in the test
 * file would happily keep passing while sw.js regressed.
 */
function loadSw(origin = 'https://chtrm.vercel.app') {
  const src = readFileSync(resolve(root, 'public/sw.js'), 'utf8');
  const listeners = {};
  const sandbox = {
    self: null,
    caches: {
      keys: async () => [],
      // A cache double that records puts, so a test can assert what would have
      // been stored as well as whether respondWith was called at all.
      open: async () => ({
        match: async () => undefined,
        put: async (req, res) => { sandbox.__puts.push(req?.url ?? String(req)); },
      }),
      delete: async () => true,
    },
    __puts: [],
    fetch: async () => ({ ok: true, status: 200, clone: () => ({}) }),
    URL,
    console,
  };
  const self = {
    location: new URL(origin),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  sandbox.self = self;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { self, listeners, origin, puts: sandbox.__puts };
}

describe('service worker: video is never cached or intercepted', () => {
  let sw;
  beforeAll(() => { sw = loadSw(); });

  const o = 'https://chtrm.vercel.app';

  // The requirement, stated as data. Each of these MUST be left to the network.
  const mustBypass = [
    ['segment relay', `${o}/api/seg?u=https%3A%2F%2Fcdn.example%2Fx.ts&k=abc`],
    ['segment relay bare', `${o}/api/seg`],
    ['m3u8 playlist route', `${o}/api/m3u8?u=https%3A%2F%2Fcdn.example%2Fmaster.m3u8`],
    ['vm proxy', `${o}/api/vm/health`],
    ['vm proxy deep path', `${o}/api/vm/some/nested/path?x=1`],
    ['resolve stream (SSE)', `${o}/api/resolve/movie/12345/stream`],
    ['resolve progress', `${o}/api/resolve/tv/999/progress`],
    ['.ts segment', `${o}/media/chunk-00042.ts`],
    ['.ts with query', `${o}/media/chunk.ts?token=deadbeef`],
    ['.m4s segment', `${o}/media/seg-1.m4s`],
    ['.mp4 file', `${o}/media/movie.mp4`],
    ['.m3u8 file', `${o}/media/index.m3u8`],
    ['other api route', `${o}/api/search?q=arjun`],
  ];

  for (const [label, url] of mustBypass) {
    it(`bypasses ${label}`, () => {
      expect(sw.self.shouldBypass(url, 'GET')).toBe(true);
    });
  }

  it('bypasses every media URL as a group (single assertion over the set)', () => {
    const intercepted = mustBypass
      .map(([label, url]) => [label, sw.self.shouldBypass(url, 'GET')])
      .filter(([, bypassed]) => bypassed !== true)
      .map(([label]) => label);
    expect(intercepted).toEqual([]);
  });

  it('never caches a non-GET request', () => {
    expect(sw.self.shouldBypass(`${o}/_next/static/chunk.js`, 'POST')).toBe(true);
  });

  it('leaves cross-origin requests alone', () => {
    expect(sw.self.shouldBypass('https://image.tmdb.org/t/p/w500/a.jpg', 'GET')).toBe(true);
  });

  it('the fetch handler does not call respondWith for a segment', () => {
    let respondedWith = false;
    sw.listeners.fetch({
      request: { url: `${o}/api/seg?u=x`, method: 'GET', headers: { get: () => null } },
      respondWith: () => { respondedWith = true; },
    });
    expect(respondedWith).toBe(false);
  });

  it('the fetch handler does not call respondWith for a .ts URL', () => {
    let respondedWith = false;
    sw.listeners.fetch({
      request: { url: `${o}/x/seg.ts`, method: 'GET', headers: { get: () => null } },
      respondWith: () => { respondedWith = true; },
    });
    expect(respondedWith).toBe(false);
  });

  /*
   * Defence in depth.
   *
   * The handler drops media for two independent reasons: shouldBypass says so,
   * AND isShellAsset does not claim it. That redundancy is good, but it means a
   * test that only drives the handler stays green when the bypass is deleted —
   * isShellAsset silently covers for it. (Verified: deleting the bypass rules
   * left the handler-level tests passing.)
   *
   * So this asserts the bypass carries the media set ON ITS OWN, which is the
   * guarantee that survives someone later widening what counts as shell.
   */
  it('the bypass rule alone rejects media, without relying on isShellAsset', () => {
    const notCoveredByBypass = mustBypass
      .filter(([, url]) => sw.self.shouldBypass(url, 'GET') !== true)
      .map(([label]) => label);
    expect(notCoveredByBypass).toEqual([]);
  });

  it('isShellAsset alone also rejects media, as the second line of defence', () => {
    const claimedAsShell = mustBypass
      .filter(([, url]) => sw.self.isShellAsset(url) === true)
      .map(([label]) => label);
    expect(claimedAsShell).toEqual([]);
  });

  it('no media URL ever reaches cache.put, end to end through the handler', async () => {
    const fresh = loadSw();
    for (const [, url] of mustBypass) {
      const event = {
        request: { url, method: 'GET', headers: { get: () => null } },
        respondWith: (p) => { event.__promise = p; },
      };
      fresh.listeners.fetch(event);
      if (event.__promise) await event.__promise;
    }
    // Let any cache.put microtasks the handler kicked off settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(fresh.puts).toEqual([]);
  });

  it('ignores range requests even for otherwise-shell URLs', () => {
    let respondedWith = false;
    sw.listeners.fetch({
      request: {
        url: `${o}/_next/static/chunk.js`,
        method: 'GET',
        headers: { get: (h) => (h === 'range' ? 'bytes=0-100' : null) },
      },
      respondWith: () => { respondedWith = true; },
    });
    expect(respondedWith).toBe(false);
  });
});

describe('service worker: the app shell IS cached', () => {
  let sw;
  beforeAll(() => { sw = loadSw(); });
  const o = 'https://chtrm.vercel.app';

  const shell = [
    `${o}/_next/static/chunks/main-abc123.js`,
    `${o}/_next/static/css/app.css`,
    `${o}/icons/icon-192.png`,
  ];

  for (const url of shell) {
    it(`caches ${url.replace(o, '')}`, () => {
      expect(sw.self.shouldBypass(url, 'GET')).toBe(false);
      expect(sw.self.isShellAsset(url)).toBe(true);
    });
  }

  it('calls respondWith for a static chunk', () => {
    let respondedWith = false;
    sw.listeners.fetch({
      request: {
        url: `${o}/_next/static/chunks/main-abc.js`,
        method: 'GET',
        headers: { get: () => null },
      },
      respondWith: () => { respondedWith = true; },
    });
    expect(respondedWith).toBe(true);
  });
});

describe('web app manifest', () => {
  const m = manifest();

  it('parses as valid JSON', () => {
    expect(() => JSON.parse(JSON.stringify(m))).not.toThrow();
  });

  it('has the fields Android requires for an install', () => {
    expect(m.name).toBe('Chitram');
    expect(m.short_name).toBeTruthy();
    expect(m.short_name.length).toBeLessThanOrEqual(12);
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.orientation).toBe('any');
  });

  it('uses the dark app theme', () => {
    // Must match --color-bg in app/tokens.css (6 7 12).
    expect(m.theme_color).toBe('#06070C');
    expect(m.background_color).toBe('#06070C');
  });

  it('declares a 192 and a 512 PNG plus a maskable icon', () => {
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.every((i) => i.type === 'image/png')).toBe(true);
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(m.icons.some((i) => i.purpose === 'any')).toBe(true);
  });

  it('every icon file it references exists on disk', () => {
    for (const icon of m.icons) {
      const p = resolve(root, 'public', icon.src.replace(/^\//, ''));
      expect(existsSync(p), `${icon.src} missing`).toBe(true);
    }
  });

  it('every icon is a real PNG at its declared dimensions', () => {
    for (const icon of m.icons) {
      const p = resolve(root, 'public', icon.src.replace(/^\//, ''));
      const buf = readFileSync(p);
      // PNG signature
      expect(
        buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        `${icon.src} is not a PNG`,
      ).toBe(true);
      // IHDR width/height live at bytes 16..24
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(width, `${icon.src} width`).toBe(w);
      expect(height, `${icon.src} height`).toBe(h);
      // A placeholder/empty file would be a few hundred bytes at most.
      expect(buf.length, `${icon.src} suspiciously small`).toBeGreaterThan(1000);
    }
  });

  it('does not also ship a static manifest that would shadow the route', () => {
    expect(existsSync(resolve(root, 'public/manifest.webmanifest'))).toBe(false);
  });
});
