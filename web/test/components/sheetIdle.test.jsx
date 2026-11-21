import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

// W1: on a phone the sheet closed itself after 3s, so a slow tap landed on the
// video. Touch keeps a picker open until the viewer closes it.
let coarse = false;
window.matchMedia = (q) => ({
  matches: coarse && /pointer:\s*coarse/.test(q) && !/max-width/.test(q), media: q,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

vi.mock('../../components/Icon', () => ({ default: () => null }));
const { default: PlayerControls, sheetIdleMs } = await import('../../components/PlayerControls');

const AUDIO = [{ id: 0, name: 'Hindi', lang: 'hin' }, { id: 1, name: 'Telugu', lang: 'tel' }];
function mount() {
  const video = document.createElement('video');
  Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
  return render(
    <PlayerControls videoRef={{ current: video }} title="RRR" visible
                    sources={[{ provider: 'CastleTV' }]} currentSource="CastleTV"
                    levels={[]} currentLevel={-1} subs={[]} currentSub={null}
                    audioTracks={AUDIO} currentAudio={1} />,
  );
}
const openAudio = (c) => fireEvent.click(c.querySelector('[aria-label^="Audio language"]'));

afterEach(() => { vi.useRealTimers(); coarse = false; });

describe('sheet idle close', () => {
  it('waits 10s on mouse and TV, never on touch', () => {
    expect(sheetIdleMs({ tv: true, coarse: false })).toBe(10000);
    expect(sheetIdleMs({ tv: false, coarse: false })).toBe(10000);
    expect(sheetIdleMs({ tv: false, coarse: true })).toBeNull();
    // A TV remote is not a coarse pointer case: it keeps its 10s timer.
    expect(sheetIdleMs({ tv: true, coarse: true })).toBe(10000);
  });

  it('a touch picker stays open past 10s', async () => {
    vi.useFakeTimers();
    coarse = true;
    const { container } = mount();
    openAudio(container);
    expect(container.querySelector('.pmenu')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(container.querySelector('.pmenu')).toBeTruthy();
  });

  it('a mouse picker still closes after 10s idle, not 3s', async () => {
    vi.useFakeTimers();
    const { container } = mount();
    openAudio(container);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(container.querySelector('.pmenu')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(container.querySelector('.pmenu')).toBeNull();
  });

  it('audio rows sit under In this stream / Other servers', () => {
    const { container } = mount();
    openAudio(container);
    const heads = [...container.querySelectorAll('.pmenu-group')].map(h => h.textContent);
    expect(heads).toEqual(['In this stream']);
  });
});
