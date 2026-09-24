import { describe, it, expect } from 'vitest';

/**
 * ?tv= and ?native= are testing overrides, and they used to win FOREVER.
 *
 * That is right on the device you set it on, and wrong everywhere else: one
 * `?tv=1` url pinned a laptop into the 10-foot layout on every later visit,
 * with no way back except `?tv=0` or clearing site data. They now expire.
 */

const DAY = 24 * 60 * 60 * 1000;

/** The stored-value rule, isolated from the DOM. */
function decide(raw, now, sniff = false) {
  if (!raw) return sniff;
  if (raw === '1' || raw === '0') return raw === '1';   // legacy, honoured once
  try {
    const { v, until } = JSON.parse(raw);
    if (Number.isFinite(until) && until > now) return v === '1';
  } catch { /* corrupt */ }
  return sniff;
}

const stored = (v, now) => JSON.stringify({ v, until: now + DAY });

describe('a remembered tv/native override', () => {
  const NOW = 1_800_000_000_000;

  it('applies right after it is set', () => {
    expect(decide(stored('1', NOW), NOW + 1000, false)).toBe(true);
  });

  it('still applies later the same day', () => {
    expect(decide(stored('1', NOW), NOW + 12 * 3600_000, false)).toBe(true);
  });

  it('lapses back to the sniff after a day', () => {
    // The reported problem: a laptop stuck in the TV layout indefinitely.
    expect(decide(stored('1', NOW), NOW + DAY + 1000, false)).toBe(false);
  });

  it('lets ?tv=0 turn the layout OFF while it lasts', () => {
    // The override must be able to say "not a TV" against a positive sniff.
    expect(decide(stored('0', NOW), NOW + 1000, true)).toBe(false);
  });

  it('falls back to the sniff when nothing is stored', () => {
    expect(decide(null, NOW, true)).toBe(true);
    expect(decide(null, NOW, false)).toBe(false);
  });

  it('honours a legacy bare flag rather than stranding an existing user', () => {
    expect(decide('1', NOW, false)).toBe(true);
    expect(decide('0', NOW, true)).toBe(false);
  });

  it('ignores a corrupted value instead of locking the layout', () => {
    expect(decide('{not json', NOW, false)).toBe(false);
    expect(decide(JSON.stringify({ v: '1' }), NOW, false)).toBe(false);  // no expiry
  });
});

describe('both overrides share one implementation', () => {
  it('Player uses the shared helper rather than its own copy', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../components/Player.jsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/readOverride\('chitram\.native', 'native'/);
    // The old inline copy wrote a bare flag that never expired.
    expect(src).not.toMatch(/setItem\('chitram\.native',\s*q\)/);
  });

  it('dpad exports it so there is one rule, not two', async () => {
    const mod = await import('../lib/dpad.js');
    expect(typeof mod.readOverride).toBe('function');
  });
});
