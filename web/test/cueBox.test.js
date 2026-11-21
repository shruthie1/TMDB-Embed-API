import { describe, it, expect } from 'vitest';
import { pictureBox } from '../lib/player/useCueOverlay';

/**
 * The caption layer is a sibling of the <video>, absolutely positioned in
 * .player, so the picture box must be in .player's coordinates.
 *
 * Regression (e0c9d28, fit 'width' default): the 'width' fit makes the video
 * element height-auto and vertically centred, but the box was computed in the
 * ELEMENT's own coordinates. A 2.39:1 film in a 2000x1200 stage is an 837px
 * element starting 182px down, so the layer sat 182px too high and the
 * caption floated at ~60% of the picture height.
 */

const stage = { left: 0, top: 0, width: 2000, height: 1200 };

/** The rect the browser reports for `.video[data-fit="width"]`. */
function widthFitRect(stageRect, ar) {
  const h = Math.min(stageRect.width / ar, stageRect.height);
  const w = h * ar < stageRect.width ? h * ar : stageRect.width;
  return { left: stageRect.left, top: stageRect.top + (stageRect.height - h) / 2,
           width: stageRect.width, height: h, _picW: w };
}

describe('pictureBox: caption layer in stage coordinates', () => {
  it('puts a 2.39:1 film\'s layer on the picture in fit-width (the reported bug)', () => {
    const r = widthFitRect(stage, 2.39);
    const box = pictureBox({ videoW: 1912, videoH: 800, rect: r, host: stage, fit: 'width' });
    // Bottom of the layer = bottom of the picture, not 182px above it.
    expect(box.top).toBeCloseTo(r.top, 3);
    expect(box.top + box.height).toBeCloseTo(r.top + r.height, 3);
    expect(box.top).toBeGreaterThan(180);
  });

  it('accounts for a baked-in letterbox inside a centred 16:9 element', () => {
    const r = widthFitRect(stage, 16 / 9);            // 1125 tall, 37.5px down
    const inset = 0.13;
    const box = pictureBox({ videoW: 1920, videoH: 1080, rect: r, host: stage,
                             fit: 'width', inset });
    expect(box.top).toBeCloseTo(37.5 + 1125 * inset, 3);
    expect(box.top + box.height).toBeCloseTo(37.5 + 1125 * (1 - inset), 3);
  });

  it('is unchanged for inset:0 fits (element == stage)', () => {
    const r = { ...stage };
    const box = pictureBox({ videoW: 1920, videoH: 800, rect: r, host: stage, fit: 'contain' });
    const picH = 2000 / 2.4;
    expect(box.top).toBeCloseTo((1200 - picH) / 2, 3);
    expect(box.height).toBeCloseTo(picH, 3);
    expect(box.left).toBe(0);
  });

  it('works at phone width (portrait, 390x844)', () => {
    const phone = { left: 0, top: 0, width: 390, height: 844 };
    const r = widthFitRect(phone, 16 / 9);
    const box = pictureBox({ videoW: 1920, videoH: 1080, rect: r, host: phone, fit: 'width' });
    expect(box.top + box.height).toBeCloseTo((844 + 390 / (16 / 9)) / 2, 3);
  });

  it('handles a tall film clamped by max-height (side bars) in fit-width', () => {
    const r = { left: 0, top: 0, width: 2000, height: 1200 };  // clamped: full height
    const box = pictureBox({ videoW: 1080, videoH: 1920, rect: r, host: stage, fit: 'width' });
    expect(box.height).toBeCloseTo(1200, 3);
    expect(box.width).toBeCloseTo(1200 * 1080 / 1920, 3);
    expect(box.left).toBeCloseTo((2000 - box.width) / 2, 3);
  });

  it('offsets the pre-metadata fallback too', () => {
    const r = { left: 0, top: 525, width: 2000, height: 150 };
    expect(pictureBox({ videoW: 0, videoH: 0, rect: r, host: stage, fit: 'width' }))
      .toEqual({ left: 0, top: 525, width: 2000, height: 150 });
  });

  it('host is optional (old element-relative behaviour)', () => {
    const r = { left: 0, top: 182, width: 2000, height: 836.8 };
    const box = pictureBox({ videoW: 1912, videoH: 800, rect: r, fit: 'width' });
    expect(box.top).toBe(0);
  });
});
