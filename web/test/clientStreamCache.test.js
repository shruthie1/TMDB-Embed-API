import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveLive, prewarmStreams, listSources, refreshStreams, forgetTitleStreams, STREAMS_RETRY_DELAYS_MS } from '../lib/backend';
import { getSlot, putSlot, titleKey, _resetStreamCache, STREAM_CACHE_TTL_MS, STREAM_CACHE_MAX_TITLES } from '../lib/streamCache';
import { urlExpiresAt } from '../lib/urlExpiry';
import { oneTouchRowsCached, prewarmClientProviders, _resetClientPrewarm } from '../lib/clientPrewarm';

// P15 (2026-11-22): the web keeps stream rows 30 min per title, like the APK.

const body = (streams, extra = {}) => ({ success: true, count: streams.length, providerTimings: {}, streams, ...extra });
const CASTLE = { url: 'https://cdn/castle.m3u8', provider: 'CastleTV', quality: '1080p', container: 'hls', languages: ['Telugu'] };
const NM = { url: 'https://cdn/nm.m3u8', provider: 'NetMirror', quality: '1080p', container: 'hls', languages: ['Telugu'] };
const OT = { url: 'https://hitv/ot.m3u8', provider: 'OneTouchTV', quality: '1080p', container: 'hls' };
const res = (json) => ({ ok: true, status: 200, json: async () => json });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const streamCalls = (f) => f.mock.calls.filter(([u]) => String(u).includes('/api/streams')).length;

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(), _m: m };
}
function run(id, extra = {}) {
  return new Promise((resolve) => {
    resolveLive('movie', id, { ...extra, onDone: (s) => resolve({ ok: s }), onFail: (e) => resolve({ err: e }) });
  });
}

let logs;
let store;
beforeEach(() => {
  store = memoryStorage();
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('sessionStorage', memoryStorage());
  _resetStreamCache();
  _resetClientPrewarm();
  STREAMS_RETRY_DELAYS_MS.splice(0, STREAMS_RETRY_DELAYS_MS.length, 1, 1);
  logs = [];
  vi.spyOn(console, 'info').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('URL expiry port (web lib/urlExpiry.js)', () => {
  const now = 1_763_800_000_000;
  const sec = Math.floor((now + 600_000) / 1000);
  it.each(['e', 'exp', 'expire', 'expires', 'Expires', 'EXPIRES', 'Exp', 'E'])('reads %s= in any case', (p) => {
    expect(urlExpiresAt(`https://cdn/x.m3u8?a=1&${p}=${sec}`, now)).toBe(sec * 1000);
  });
  it('reads a proxied upstream (Castle Expires inside ?url=)', () => {
    const inner = `https://img1.hscow.com/a.m3u8?Expires=${sec}&Signature=x`;
    expect(urlExpiresAt(`https://vm/m3u8-proxy?url=${encodeURIComponent(inner)}`, now)).toBe(sec * 1000);
  });
  it('ignores a number outside 30 days back .. 366 days ahead', () => {
    expect(urlExpiresAt('https://cdn/x?e=1000000000', now)).toBeNull();
  });
});

describe('client stream cache (P15)', () => {
  it('a second Play within 30 min makes 0 stream requests, and logs hit/miss', async () => {
    const f = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', f);
    await run(701);
    expect(streamCalls(f)).toBe(1);
    const again = await run(701);
    expect(again.ok?.masterUrl).toBe(CASTLE.url);
    expect(streamCalls(f)).toBe(1);
    expect(logs).toContain('[cache] miss movie:701:0:0#vm');
    expect(logs).toContain('[cache] hit movie:701:0:0#vm');
  });

  it('a reopen (prewarm + Play + NetMirror lookup) within 30 min makes 0 stream requests', async () => {
    const f = vi.fn(async (u) => res(body(String(u).includes('/netmirror/') ? [NM] : [CASTLE])));
    vi.stubGlobal('fetch', f);
    const open = async () => {
      prewarmStreams('movie', 702);
      await tick(2);
      await run(702);
      await listSources('movie', 702, { provider: 'netmirror' });
    };
    await open();
    const first = streamCalls(f);
    expect(first).toBe(2);
    await open();
    expect(streamCalls(f)).toBe(first);
  });

  it('survives a reload: rows come back from localStorage', async () => {
    const f = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', f);
    await run(703);
    _resetStreamCache({ clearStorage: false });   // new page, same storage
    await run(703);
    expect(streamCalls(f)).toBe(1);
  });

  it('an entry ends at 30 min', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const f = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', f);
    await run(704);
    now.mockReturnValue(5_000_000 + STREAM_CACHE_TTL_MS - 1000);
    await run(704);
    expect(streamCalls(f)).toBe(1);
    now.mockReturnValue(5_000_000 + STREAM_CACHE_TTL_MS + 1);
    await run(704);
    expect(streamCalls(f)).toBe(2);
  });

  it('an earlier URL expiry ends the entry first (30 s skew)', () => {
    const t0 = 1_763_800_000_000;
    const exp = Math.floor((t0 + 5 * 60_000) / 1000);
    const key = titleKey('movie', 705);
    putSlot(key, 'vm', body([{ ...CASTLE, url: `https://cdn/a.m3u8?Expires=${exp}` }]), t0);
    expect(getSlot(key, 'vm', t0 + 4 * 60_000)).not.toBeNull();
    expect(getSlot(key, 'vm', exp * 1000 - 29_000)).toBeNull();
  });

  it('a web-direct url with an earlier expiry also bounds the entry', () => {
    const t0 = 1_763_800_000_000;
    const exp = Math.floor((t0 + 2 * 60_000) / 1000);
    const key = titleKey('movie', 706);
    putSlot(key, 'vm', body([{ ...CASTLE, directUrl: `https://img1.hscow.com/a.m3u8?expires=${exp}` }]), t0);
    expect(getSlot(key, 'vm', t0 + 3 * 60_000)).toBeNull();
  });

  it('keeps at most 50 titles; the oldest write goes first', () => {
    for (let i = 0; i <= STREAM_CACHE_MAX_TITLES; i++) putSlot(titleKey('movie', 1000 + i), 'vm', body([CASTLE]), 1_000 + i);
    expect(getSlot(titleKey('movie', 1000), 'vm', 2_000)).toBeNull();
    expect(getSlot(titleKey('movie', 1001), 'vm', 2_000)).not.toBeNull();
    expect(JSON.parse(store.getItem('chitram:streamCache:v1')).length).toBe(STREAM_CACHE_MAX_TITLES);
  });

  it('TV episodes are separate entries', async () => {
    const f = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', f);
    const ep = (e) => new Promise((r) => resolveLive('tv', 707, { season: 1, episode: e, onDone: r, onFail: r }));
    await ep(1); await ep(2); await ep(1);
    expect(streamCalls(f)).toBe(2);
  });

  it('a failed row drops the title; the next resolve is fresh ONCE, then kept again', async () => {
    const f = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', f);
    await run(708);
    forgetTitleStreams('movie', 708, { reason: 'row-failed' });
    expect(logs).toContain('[cache] drop movie:708:0:0 reason=row-failed');
    await run(708);
    expect(streamCalls(f)).toBe(2);
    await run(708);
    expect(streamCalls(f)).toBe(2);
  });

  it('Refresh sources clears every slot of the title (VM, NetMirror, browser rows)', async () => {
    const f = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', f);
    const key = titleKey('movie', 709);
    putSlot(key, 'vm:netmirror', body([NM]));
    putSlot(key, 'c:onetouchtv', [OT]);
    await refreshStreams('movie', 709);
    expect(getSlot(key, 'vm:netmirror')).toBeNull();
    expect(getSlot(key, 'c:onetouchtv')).toBeNull();
    // The refreshed answer is what Play now uses.
    expect(getSlot(key, 'vm')?.streams?.[0]?.url).toBe(CASTLE.url);
  });

  it('a provider-error answer is kept for 5 min only (APK parity 2026-11-22)', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(7_000_000);
    const f = vi.fn(async () => res(body([CASTLE], { providerErrors: ['castletv'] })));
    vi.stubGlobal('fetch', f);
    await run(710);
    expect(getSlot(titleKey('movie', 710), 'vm')?.streams?.length).toBe(1);
    now.mockReturnValue(7_000_000 + 5 * 60 * 1000 + 1);
    expect(getSlot(titleKey('movie', 710), 'vm')).toBeNull();
  });

  it('a refresh NetMirror lookup never reads the kept one', async () => {
    const f = vi.fn(async () => res(body([NM])));
    vi.stubGlobal('fetch', f);
    await listSources('movie', 711, { provider: 'netmirror' });
    await listSources('movie', 711, { provider: 'netmirror', refresh: true });
    expect(streamCalls(f)).toBe(2);
  });
});

describe('browser-side rows (OneTouchTV) in the cache', () => {
  it('kept rows cost no resolve; a prewarm and a Play share one', async () => {
    let release;
    const resolver = vi.fn(() => new Promise((r) => { release = () => r([OT]); }));
    prewarmClientProviders('movie', 801, { resolver });
    const play = oneTouchRowsCached({ type: 'movie', tmdbId: 801, resolver });
    await tick(0);
    release();
    expect((await play)[0].url).toBe(OT.url);
    expect(resolver).toHaveBeenCalledTimes(1);
    await oneTouchRowsCached({ type: 'movie', tmdbId: 801, resolver });
    prewarmClientProviders('movie', 801, { resolver });
    await tick(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.startsWith('[prewarm] onetouchtv start movie:801'))).toBe(true);
    expect(logs.some((l) => l.startsWith('[prewarm] onetouchtv skip kept-or-running movie:801'))).toBe(true);
  });

  it('the VM fallback uses kept browser rows with 0 provider requests', async () => {
    const f = vi.fn(async () => res(body([])));
    vi.stubGlobal('fetch', f);
    putSlot(titleKey('movie', 802), 'c:onetouchtv', [OT]);
    const resolver = vi.fn(async () => [OT]);
    const out = await new Promise((resolve) => resolveLive('movie', 802, {
      clientFallback: (type, id, o) => oneTouchRowsCached({ type, tmdbId: id, ...o, resolver }),
      onDone: (s) => resolve({ ok: s }), onFail: (e) => resolve({ err: e }),
    }));
    expect(out.ok?.provider).toBe('OneTouchTV');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('an empty browser answer is not kept', async () => {
    const resolver = vi.fn(async () => []);
    await oneTouchRowsCached({ type: 'movie', tmdbId: 803, resolver });
    await oneTouchRowsCached({ type: 'movie', tmdbId: 803, resolver });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('storage that throws still caches in memory and still plays', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } });
    _resetStreamCache({ clearStorage: false });
    const f = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', f);
    await run(804);
    const again = await run(804);
    expect(again.ok?.masterUrl).toBe(CASTLE.url);
    expect(streamCalls(f)).toBe(1);
  });
});

describe('offline (gaps 10.5, 13.10)', () => {
  it('an offline refresh keeps the kept answer', async () => {
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', f);
    const key = titleKey('movie', 721);
    putSlot(key, 'vm', body([CASTLE]));
    putSlot(key, 'vm:netmirror', body([NM]));
    putSlot(key, 'c:onetouchtv', [OT]);
    await expect(refreshStreams('movie', 721)).rejects.toBeTruthy();
    expect(getSlot(key, 'vm')?.streams?.[0]?.url).toBe(CASTLE.url);
    expect(getSlot(key, 'vm:netmirror')?.streams?.[0]?.url).toBe(NM.url);
    expect(getSlot(key, 'c:onetouchtv')?.[0]?.url).toBe(OT.url);
  });

  it('a refresh replaces the kept answer once the new one arrives', async () => {
    const NEW = { ...CASTLE, url: 'https://cdn/castle-new.m3u8' };
    const f = vi.fn(async () => res(body([NEW])));
    vi.stubGlobal('fetch', f);
    const key = titleKey('movie', 722);
    putSlot(key, 'vm', body([CASTLE]));
    await refreshStreams('movie', 722);
    expect(getSlot(key, 'vm')?.streams?.[0]?.url).toBe(NEW.url);
  });

  it('prewarm sends nothing while the browser is offline', async () => {
    const f = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', f);
    vi.stubGlobal('navigator', { onLine: false });
    const resolver = vi.fn(async () => [OT]);
    prewarmStreams('movie', 723);
    prewarmClientProviders('movie', 723, { resolver });
    await tick(1);
    expect(streamCalls(f)).toBe(0);
    expect(resolver).not.toHaveBeenCalled();
    expect(logs).toContain('[prewarm] vm skip offline');
    expect(logs.some((l) => l.startsWith('[prewarm] onetouchtv skip offline movie:723'))).toBe(true);
  });
});
