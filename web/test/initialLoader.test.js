import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../components/Player.jsx', import.meta.url)), 'utf8');

/**
 * Something must be on screen from the moment play is pressed to the first
 * frame.
 *
 * There used to be a hole between two overlays: `Resolving` renders only while
 * `!stream`, so it vanishes the instant a url arrives, and the buffering
 * overlay rendered only during a stall or a source switch. In between - while
 * hls.js fetches the manifest, the variant and the first segment - nothing
 * rendered at all. On a 4K source that is several seconds of black screen with
 * no spinner and no play icon, which reads as stuck rather than loading.
 */
describe('the gap between resolve and first frame', () => {
  it('keeps a loader up while a stream exists but has not started', () => {
    const busy = src.match(/const busy = [^;]+;/)[0];
    expect(busy).toMatch(/stream/);
    expect(busy).toMatch(/started/);
  });

  it('still covers the two cases it always did', () => {
    // A stall and a deliberate source switch must not lose their loader.
    const busy = src.match(/const busy = [^;]+;/)[0];
    expect(busy).toMatch(/stallStage/);
    expect(busy).toMatch(/switching/);
  });

  it('flips on `playing`, not `play`', () => {
    // `play` fires when playback is REQUESTED, which is true long before a
    // frame exists. Using it would hide the loader over a black screen.
    expect(src).toMatch(/addEventListener\('playing', onPlaying\)/);
    expect(src).toMatch(/setStarted\(true\)/);
  });

  it('re-arms for a new stream, so a source switch shows the loader again', () => {
    // Without this, `started` stays true from the previous source and the
    // switch renders nothing.
    // Asserts the PROPERTY - the reset effect is keyed on `stream` - rather
    // than counting characters between the two. The original regex allowed 40
    // and broke the moment a comment and a second reset were added alongside
    // it, which is a test failing on formatting rather than on behaviour.
    const reset = src.match(/useEffect\(\(\) => \{[\s\S]*?setStarted\(false\)[\s\S]*?\}, \[([^\]]*)\]\)/);
    expect(reset, 'a reset effect keyed on stream must exist').not.toBeNull();
    expect(reset[1].trim()).toBe('stream');
  });

  it('does not re-arm on an ordinary pause', () => {
    // `started` must be one-way per stream: pausing is not loading, and a
    // loader over a paused frame would be wrong.
    const pauseHandler = src.match(/const sync = \(\) => setPlaying[^;]+;/)[0];
    expect(pauseHandler).not.toMatch(/setStarted/);
  });
});

describe('manual recovery uses the validated ladder', () => {
  it('does not make the stuck action blindly re-resolve first', () => {
    const stuck = src.slice(src.indexOf("recovery.stallStage === 'stuck'"), src.indexOf("recovery.stallStage === 'stuck'") + 900);
    expect(stuck).toMatch(/recoverBySwitching\('manual recovery'\)/);
    expect(stuck).toMatch(/resolve\.load\(true\)/);
    expect(stuck.indexOf('recoverBySwitching')).toBeLessThan(stuck.indexOf('resolve.load'));
  });

  it('reports fatal decoder/network errors as playback failures', () => {
    expect(src).toMatch(/reportPlayback\(\{ \.\.\.reportCtx\.current, \.\.\.reportMetrics\(\), ok: false/);
    expect(src).toMatch(/incompatible codecs/);
  });
});
