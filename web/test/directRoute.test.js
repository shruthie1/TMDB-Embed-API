import { describe, it, expect, beforeEach } from 'vitest';
import { planPlayUrl, isEarlyFailure, markDirectFailed, _resetDirectFailures, DIRECT_FIRST_FRAME_MS } from '../lib/player/directRoute';
import { toSource } from '../lib/backend';

const PROXY = 'https://vm.example/m3u8-proxy?url=https%3A%2F%2Fimg1.hscow.com%2Fa.m3u8';
const DIRECT = 'https://img1.hscow.com/a.m3u8';

beforeEach(() => _resetDirectFailures());

describe('toSource carries the web-direct url only when the config allows it', () => {
  it('route.web direct -> webDirectUrl; masterUrl stays the proxied url', () => {
    const s = toSource({ url: PROXY, directUrl: DIRECT, route: { web: 'direct', apk: 'direct' }, provider: 'CastleTV', languages: ['Telugu'] });
    expect(s.masterUrl).toBe(PROXY);
    expect(s.webDirectUrl).toBe(DIRECT);
    expect(s.languages).toEqual(['Telugu']);
  });
  it('route.web proxy (apk-only direct) -> no webDirectUrl', () => {
    const s = toSource({ url: PROXY, directUrl: DIRECT, route: { web: 'proxy', apk: 'direct' }, provider: 'showsst' });
    expect(s.webDirectUrl).toBe(null);
  });
  it('old server (no route) -> no webDirectUrl', () => {
    expect(toSource({ url: PROXY, provider: 'CastleTV' }).webDirectUrl).toBe(null);
  });
});

describe('planPlayUrl', () => {
  const src = { id: 'CastleTV-0', provider: 'CastleTV', masterUrl: PROXY, webDirectUrl: DIRECT };
  it('direct first when allowed', () => {
    expect(planPlayUrl(src)).toEqual({ url: DIRECT, mode: 'direct', reason: 'config-direct' });
  });
  it('proxy when the row has no direct url', () => {
    expect(planPlayUrl({ ...src, webDirectUrl: null })).toEqual({ url: PROXY, mode: 'proxy', reason: 'config-proxy' });
  });
  it('proxy once this row already failed direct (one fallback per row)', () => {
    markDirectFailed(src);
    expect(planPlayUrl(src)).toEqual({ url: PROXY, mode: 'proxy', reason: 'direct-failed-before' });
  });
  it('proxy when there is no proxied url to fall back to is never invented', () => {
    expect(planPlayUrl({ masterUrl: null, webDirectUrl: DIRECT }).url).toBe(DIRECT);
  });
});

describe('isEarlyFailure: only FATAL errors before the first frame', () => {
  it('fatal before first frame', () => {
    expect(isEarlyFailure({ fatal: true, details: 'manifestLoadError' }, false)).toBe(true);
  });
  // hls.js retries non-fatal load errors itself; one transient fragment error
  // must not move the row to the proxy for the whole page session.
  for (const details of ['manifestLoadError', 'levelLoadError', 'fragLoadError', 'fragLoadTimeOut', 'bufferStalledError']) {
    it(`non-fatal ${details} is left to hls.js`, () => {
      expect(isEarlyFailure({ fatal: false, details }, false)).toBe(false);
    });
  }
  it('anything after the first frame is not an early failure', () => {
    expect(isEarlyFailure({ fatal: true, details: 'fragLoadError' }, true)).toBe(false);
  });
  it('first-frame deadline is 10 s', () => {
    expect(DIRECT_FIRST_FRAME_MS).toBe(10000);
  });
});
