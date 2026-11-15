import { describe, it, expect, vi } from 'vitest';
import { probeTsAudio, swapPids } from '../lib/player/tsAudio';
import { muxedAudioLoader } from '../lib/player/useHls';
import { buildTs, CASTLE } from './fixtures/ts';

const pidAt = (u8, i) => ((u8[i * 188 + 1] & 0x1f) << 8) | u8[i * 188 + 2];
const marker = (u8, i) => (u8[i * 188 + 5] << 8) | u8[i * 188 + 6];

describe('probeTsAudio', () => {
  it('lists every AAC track with its language, in PMT order', () => {
    expect(probeTsAudio(buildTs(CASTLE))).toEqual([
      { pid: 0x101, lang: 'hin' }, { pid: 0x102, lang: 'mal' }, { pid: 0x103, lang: 'tam' },
      { pid: 0x104, lang: 'tel' }, { pid: 0x105, lang: 'kan' },
    ]);
  });

  it('reports an untagged or "und" track as null, never a guessed language', () => {
    const t = probeTsAudio(buildTs([{ pid: 0x101 }, { pid: 0x102, lang: 'und' }]));
    expect(t).toEqual([{ pid: 0x101, lang: null }, { pid: 0x102, lang: null }]);
  });

  it('leaves out non-AAC audio, which hls.js would not demux from the AAC slot', () => {
    const t = probeTsAudio(buildTs(CASTLE.slice(0, 2), { extra: [{ pid: 0x106, lang: 'eng', type: 0x81 }] }));
    expect(t.map((x) => x.lang)).toEqual(['hin', 'mal']);
  });

  it('returns null - unknown, not "no audio" - for anything that is not clean TS', () => {
    expect(probeTsAudio(new Uint8Array(0))).toBeNull();
    expect(probeTsAudio(new Uint8Array(188 * 4))).toBeNull();          // fMP4 / ciphertext
    const broken = buildTs(CASTLE); broken[188 * 3] = 0x00;            // lost sync
    expect(probeTsAudio(broken)).toBeNull();
  });
});

describe('swapPids', () => {
  it('moves the chosen track into the slot hls.js reads, and nothing else', () => {
    const u8 = buildTs(CASTLE);
    expect(swapPids(u8, 0x101, 0x104)).toBe(true);
    // Packet 3 carried Hindi on 0x101; packet 6 carried Telugu on 0x104.
    expect(pidAt(u8, 3)).toBe(0x104);
    expect(pidAt(u8, 6)).toBe(0x101);
    // The data travels with its new PID: 0x101 now carries Telugu's bytes.
    expect(marker(u8, 6)).toBe(0x104);
    // Video, PAT, PMT and the other languages are untouched.
    expect([0, 1, 2, 4, 5, 7].map((i) => pidAt(u8, i))).toEqual([0, 0x1000, 0x100, 0x102, 0x103, 0x105]);
  });

  it('keeps the flag bits of a rewritten packet (PES starts must survive)', () => {
    const u8 = buildTs(CASTLE);
    u8[3 * 188 + 1] |= 0x40;                     // Hindi packet starts a PES
    swapPids(u8, 0x101, 0x104);
    expect(u8[3 * 188 + 1] & 0xe0).toBe(0x40);
    expect(pidAt(u8, 3)).toBe(0x104);
  });

  it('is its own inverse, so switching back restores the original bytes', () => {
    const orig = buildTs(CASTLE);
    const u8 = orig.slice();
    swapPids(u8, 0x101, 0x104);
    swapPids(u8, 0x101, 0x104);
    expect(u8).toEqual(orig);
  });

  it('refuses a buffer that is not clean TS and leaves it untouched', () => {
    const u8 = buildTs(CASTLE); u8[188 * 4] = 0x00;
    const before = u8.slice();
    expect(swapPids(u8, 0x101, 0x104)).toBe(false);
    expect(u8).toEqual(before);
  });
});

describe('muxedAudioLoader', () => {
  class FakeBase {
    load(context, _config, callbacks) {
      callbacks.onSuccess({ data: this.data }, {}, context, null);
    }
  }
  it('runs the transform on success and still hands the response on', () => {
    const muxed = { transform: vi.fn() };
    const Loader = muxedAudioLoader(FakeBase, muxed);
    const l = new Loader();
    l.data = new ArrayBuffer(8);
    const onSuccess = vi.fn();
    l.load({ frag: { type: 'main' } }, {}, { onSuccess, onError() {}, onTimeout() {} });
    expect(muxed.transform).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('a throwing transform never blocks playback', () => {
    const Loader = muxedAudioLoader(FakeBase, { transform() { throw new Error('boom'); } });
    const onSuccess = vi.fn();
    new Loader().load({}, {}, { onSuccess, onError() {}, onTimeout() {} });
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
