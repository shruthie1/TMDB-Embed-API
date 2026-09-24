import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectBakedBars } from '../lib/player/useCueOverlay';

/**
 * A 2.35:1 film delivered in a 16:9 raster carries its letterbox as real black
 * pixels. videoWidth/videoHeight report 1920x1080 either way, so geometry
 * cannot see it and the caption box was sized to the raster - putting a
 * bottom-aligned caption inside the bar, floating in the middle of the image.
 */

const SW = 32, SH = 64;

/** A fake frame: `barFrac` of the height black at top and bottom, rest grey. */
function frame({ barFrac = 0, fill = 128, barLum = 0, topOnly = false } = {}) {
  const data = new Uint8ClampedArray(SW * SH * 4);
  const bar = Math.round(SH * barFrac);
  for (let y = 0; y < SH; y++) {
    const inBar = y < bar || (!topOnly && y >= SH - bar);
    const v = inBar ? barLum : fill;
    for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** A <video> whose canvas returns the given frame. */
function video(data, { videoWidth = 1920, videoHeight = 1080, readyState = 4 } = {}) {
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data }),
      }),
    }),
  };
  return { videoWidth, videoHeight, readyState };
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe('detectBakedBars', () => {
  it('finds the bar on a scope film in a 16:9 raster', () => {
    // 2.35:1 in 16:9 leaves ~12% of the height as bar, top and bottom.
    const got = detectBakedBars(video(frame({ barFrac: 0.12 })));
    expect(got).toBeGreaterThan(0.09);
    expect(got).toBeLessThan(0.15);
  });

  it('reports no bar for a film that fills its raster', () => {
    expect(detectBakedBars(video(frame({ barFrac: 0 })))).toBe(0);
  });

  it('refuses to answer on an all-black frame', () => {
    // A fade or a dark scene tells us nothing. Answering 0.5 here would snap
    // captions to the middle of the screen for the length of the fade.
    expect(detectBakedBars(video(frame({ fill: 0 })))).toBe(null);
  });

  it('refuses to answer when the frame is not ready', () => {
    expect(detectBakedBars(video(frame({ barFrac: 0.12 }), { readyState: 0 }))).toBe(null);
  });

  it('refuses to answer before dimensions are known', () => {
    expect(detectBakedBars(video(frame({}), { videoWidth: 0, videoHeight: 0 }))).toBe(null);
  });

  it('ignores a one-sided dark edge, which is a scene and not a letterbox', () => {
    // Letterboxing is symmetric. A night sky at the top is not a bar.
    expect(detectBakedBars(video(frame({ barFrac: 0.15, topOnly: true })))).toBe(null);
  });

  it('treats a sliver as no bar', () => {
    // A row or two of dark edge is compression noise, not a letterbox.
    expect(detectBakedBars(video(frame({ barFrac: 0.015 })))).toBe(0);
  });

  it('sees through compression noise in the bar', () => {
    // A real bar is not pure #000 after encoding.
    const got = detectBakedBars(video(frame({ barFrac: 0.12, barLum: 12 })));
    expect(got).toBeGreaterThan(0.09);
  });

  it('survives a canvas it is not allowed to read', () => {
    // Cross-origin frames taint the canvas; this is the NORMAL case for a CDN
    // with no CORS headers, so it must fail quietly rather than throw.
    globalThis.document = {
      createElement: () => ({
        getContext: () => ({
          drawImage: () => {},
          getImageData: () => { throw new Error('SecurityError: tainted canvas'); },
        }),
      }),
    };
    expect(detectBakedBars({ videoWidth: 1920, videoHeight: 1080, readyState: 4 })).toBe(null);
  });

  it('rejects an implausibly large bar', () => {
    // Nothing legitimate leaves 40% of the raster black per side.
    expect(detectBakedBars(video(frame({ barFrac: 0.4 })))).toBe(0);
  });
});
