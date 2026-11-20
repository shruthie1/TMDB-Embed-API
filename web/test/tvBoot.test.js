import { describe, it, expect } from 'vitest';
import { TV_BOOT_SCRIPT } from '../lib/tvBoot';
import { isTvDevice } from '../lib/player/hlsConfig';

/**
 * The inline <head> script must decide TV exactly as isTv() does, or the first
 * frame and the hydrated page disagree and the layout jumps anyway.
 */
function runBoot({ ua, search = '', stored = null, deviceMemory }) {
  const attrs = {};
  const env = {
    location: { search },
    localStorage: { getItem: k => (k === 'chitram.tv' ? stored : null) },
    navigator: { userAgent: ua, deviceMemory },
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
  };
  new Function('location', 'localStorage', 'navigator', 'document', 'URLSearchParams', TV_BOOT_SCRIPT)(
    env.location, env.localStorage, env.navigator, env.document, URLSearchParams);
  return attrs['data-tv'] === 'true';
}

function sniff(ua, deviceMemory) {
  const saved = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua, deviceMemory }, configurable: true });
  try { return isTvDevice(); } finally { Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true }); }
}

const UAS = [
  'Mozilla/5.0 (Linux; VIDAA 7.0; Hisense SmartTV) AppleWebKit/537.36 Chrome/94 Safari/537.36 Odin/2.10',
  'Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 Odin/1.0 Chrome/72',
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/79',
  'Mozilla/5.0 (Linux; Tizen 6.0) AppleWebKit/537.36 SamsungBrowser/4.0 TV Safari/537.36',
  'Mozilla/5.0 (Linux; Android 9; AFTMM) AppleWebKit/537.36 Chrome/88 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1',
];

describe('TV boot script', () => {
  it('matches the isTvDevice sniff for every user agent', () => {
    for (const ua of UAS) expect(runBoot({ ua }), ua).toBe(sniff(ua));
  });

  it('treats 2GB devices as TV, like the sniff', () => {
    const ua = UAS[5];
    expect(runBoot({ ua, deviceMemory: 2 })).toBe(sniff(ua, 2));
    expect(runBoot({ ua, deviceMemory: 8 })).toBe(sniff(ua, 8));
  });

  it('honours ?tv=1 and ?tv=0 over the sniff', () => {
    expect(runBoot({ ua: UAS[5], search: '?tv=1' })).toBe(true);
    expect(runBoot({ ua: UAS[0], search: '?tv=0' })).toBe(false);
  });

  it('honours a live stored override and ignores an expired one', () => {
    const now = Date.now();
    expect(runBoot({ ua: UAS[5], stored: JSON.stringify({ v: '1', until: now + 60_000 }) })).toBe(true);
    expect(runBoot({ ua: UAS[5], stored: JSON.stringify({ v: '1', until: now - 1 }) })).toBe(false);
    expect(runBoot({ ua: UAS[0], stored: JSON.stringify({ v: '0', until: now + 60_000 }) })).toBe(false);
    expect(runBoot({ ua: UAS[5], stored: '1' })).toBe(true);
  });

  it('falls back to the sniff on corrupt storage', () => {
    expect(runBoot({ ua: UAS[0], stored: '{bad' })).toBe(true);
  });
});
