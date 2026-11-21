import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADD_AUDIO_TRY_MS, Copy } from '../lib/player/loadingModel';
import { NOTICE_MS, makeNotice } from '../lib/player/notice';
import { createAddAudioJourney } from '../components/player/addAudioJourney';

// Fix wave I1: the "Checking {server} for {lang} audio (n of total)…" notice
// stays up for the whole donor check (the 15 s per-try cap), like the APK.
// Every other notice keeps the 4 s timing.

const PLAYING = { id: 'showsst-3', provider: 'showsst', masterUrl: 'http://x/ss.m3u8' };
const D1 = { id: 'castle-0', provider: 'CastleTV', masterUrl: 'http://x/c.m3u8', languages: ['Hindi'] };

describe('notice timing', () => {
  it('a plain notice clears after 4 s; a held one after its hold', () => {
    expect(NOTICE_MS).toBe(4000);
    expect(makeNotice('Fit: zoom', 1).ms).toBe(4000);
    expect(makeNotice('x', 2, { holdMs: ADD_AUDIO_TRY_MS }).ms).toBe(15000);
    expect(makeNotice('x', 3, 'not options').ms).toBe(4000);
    expect(makeNotice(null, 4)).toBe(null);
  });

  it('the journey holds every Checking notice for the try cap', async () => {
    const calls = [];
    let release;
    const j = createAddAudioJourney({
      checkPair: () => new Promise((r) => { release = r; }),
      applyPair: () => {}, snapshot: () => null, restore: () => {},
      notice: (text, opts) => calls.push([text, opts]),
      clearNotice: vi.fn(),
      setTimer: () => 1, clearTimer: () => {},
    });
    j.streamChanged('a');
    const p = j.start({ language: 'Hindi', video: PLAYING, donors: [D1] });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toEqual([Copy.checkingAudio('Hindi', 'CastleTV', 1, 1), { holdMs: ADD_AUDIO_TRY_MS }]);
    release(null);
    await p;
    expect(calls.at(-1)[0]).toBe(Copy.noWorkingAudio('Hindi'));
    expect(calls.at(-1)[1]).toBeUndefined();
  });

  it('a cancelled run takes its Checking notice down', async () => {
    const clearNotice = vi.fn();
    const j = createAddAudioJourney({
      checkPair: () => new Promise(() => {}),
      applyPair: () => {}, snapshot: () => null, restore: () => {},
      notice: () => {}, clearNotice,
      setTimer: () => 1, clearTimer: () => {},
    });
    j.streamChanged('a');
    j.start({ language: 'Hindi', video: PLAYING, donors: [D1] });
    await new Promise((r) => setTimeout(r, 0));
    j.cancel();
    expect(clearNotice).toHaveBeenCalledWith(Copy.checkingAudio('Hindi', 'CastleTV', 1, 1));
  });

  it('Player uses makeNotice and passes the hold and clearNotice through', () => {
    const text = readFileSync(fileURLToPath(new URL('../components/Player.jsx', import.meta.url)), 'utf8');
    expect(text).toMatch(/makeNotice\(text, \+\+noticeSeq\.current, opts\)/);
    expect(text).toMatch(/setTimeout\(\(\) => setNoticeState\(null\), notice\.ms\)/);
    expect(text).toMatch(/notice: \(text, opts\) => addAudioDeps\.current\.notice\(text, opts\)/);
    expect(text).toMatch(/clearNotice: \(text\) => addAudioDeps\.current\.clearNotice\(text\)/);
  });
});
