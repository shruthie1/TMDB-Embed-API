import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Owner rule (2026-11-21): a server switch never starts audio pairing. Pairing
// is only ever the viewer's explicit pick in the Audio menu. No test mounts
// Player.jsx (it needs hls.js, resolve, recovery and a video element), so this
// guards the switchSource body in the source text instead.
const file = fileURLToPath(new URL('../components/Player.jsx', import.meta.url));
const text = readFileSync(file, 'utf8');
const start = text.indexOf('const switchSource = useCallback(');
const end = text.indexOf('switchSourceRef.current = switchSource;');
const body = text.slice(start, end);

describe('server switch never auto-pairs', () => {
  it('finds the switchSource body', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('switchSource does not call the pair handler or the pair API', () => {
    expect(body).not.toMatch(/pickPairRef/);
    expect(body).not.toMatch(/pairSources/);
    expect(body).not.toMatch(/mode:\s*'pair'/);
  });

  // Final-review M7: the dead pickPairRef is gone; the Audio-menu pair pick
  // still reaches pickPair through pickPairGuarded.
  it('the explicit pair entry stays wired', () => {
    expect(text).not.toMatch(/pickPairRef/);
    expect(text).toMatch(/return pickPair\(plan\);/);
  });
});
