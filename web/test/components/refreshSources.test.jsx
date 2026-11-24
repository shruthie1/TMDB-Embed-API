import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import RefreshSources from '../../components/RefreshSources';
import VideoMenu from '../../components/player/VideoMenu';
import { PlayerError } from '../../components/player/overlays';
import { useRefreshSources } from '../../lib/player/useRefreshSources';
import { getSlot, titleKey, _resetStreamCache } from '../../lib/streamCache';
import {
  initialRefresh, refreshStart, refreshFinish, refreshBlocked, refreshLabel, refreshNote, refreshState,
  refreshOutcome, refreshAutoStart, resetRefreshThrottle, RefreshState, REFRESH_COOLDOWN_MS, REFRESH_NOTE_MS,
  keepPlayingRow,
} from '../../lib/player/refreshModel';
import fs from 'node:fs';
import path from 'node:path';
import { loadingView, tvFocus, RowState, Reason } from '../../lib/player/loadingModel';

// "Refresh sources" (owner 2026-11-22): the button, the VM refresh=1 call,
// the 30 s cooldown and the idle -> refreshing -> result -> cooldown journey.

const ANSWER = {
  success: true, count: 1,
  streams: [{ url: 'https://h/te-new.m3u8', provider: 'CastleTV', quality: '1080p', languages: ['Telugu', 'Hindi'] }],
};

let fetchMock;
beforeEach(() => {
  resetRefreshThrottle();
  try { sessionStorage.clear(); } catch { /* none */ }
  _resetStreamCache();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ANSWER }));
  globalThis.fetch = fetchMock;
});
afterEach(() => { cleanup(); delete document.documentElement.dataset.tv; });

function Harness({ onRows = () => {}, before = () => [] }) {
  const r = useRefreshSources({ mediaType: 'movie', tmdbId: 579974, before, onRows });
  return <RefreshSources r={r} />;
}
const button = (c) => c.querySelector('button.refresh-btn');
const note = (c) => c.querySelector('.refresh-note');

describe('Refresh sources button', () => {
  it('renders as a focusable control with the idle label', () => {
    const { container } = render(<Harness />);
    expect(button(container).textContent).toBe('Refresh sources');
    expect(button(container).getAttribute('aria-disabled')).toBeNull();
    expect(note(container).getAttribute('aria-live')).toBe('polite');
  });

  it('asks the VM once with refresh=1 and hands the new rows on', async () => {
    const onRows = vi.fn();
    const { container } = render(<Harness onRows={onRows} before={() => ['https://h/te-old.m3u8']} />);
    fireEvent.click(button(container));
    expect(button(container).textContent).toBe('Refreshing…');
    expect(button(container).getAttribute('aria-busy')).toBe('true');
    await waitFor(() => expect(onRows).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/streams/movie/579974');
    expect(url).toContain('refresh=1');
    expect(onRows.mock.calls[0][0].map((s) => s.masterUrl)).toEqual(['https://h/te-new.m3u8']);
    await waitFor(() => expect(note(container).textContent).toBe('Updated: 1 source (1 Telugu)'));
    // The new answer is kept for Play (client stream cache, 30 min).
    expect(getSlot(titleKey('movie', 579974, 0, 0), 'vm')?.streams?.[0]?.url).toContain('te-new');
  });

  it('a second tap inside 30 s sends nothing and says when', async () => {
    const { container } = render(<Harness />);
    fireEvent.click(button(container));
    await waitFor(() => expect(note(container).textContent).toMatch(/^Updated/));
    expect(button(container).textContent).toMatch(/^Refresh again in \d+s$/);
    // Still a control (aria-disabled, not disabled).
    expect(button(container).disabled).toBe(false);
    expect(button(container).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button(container));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(note(container).textContent).toMatch(/^Refresh again in \d+s$/);
  });

  it('a failed refresh keeps the old list and says so', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    const onRows = vi.fn();
    const { container } = render(<Harness onRows={onRows} />);
    fireEvent.click(button(container));
    await waitFor(() => expect(note(container).textContent).toBe("Couldn't refresh. Try again."));
    expect(onRows).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('refresh journey state', () => {
  it('idle -> refreshing -> updated -> cooldown -> idle', () => {
    const t0 = 1_000_000;
    let m = initialRefresh;
    expect(refreshState(m, t0)).toBe(RefreshState.IDLE);
    m = refreshStart(t0, t0 + REFRESH_COOLDOWN_MS);
    expect(refreshLabel(m, t0 + 100)).toBe('Refreshing…');
    m = refreshFinish(m, t0 + 5000, refreshOutcome(new Set(['old']), [
      { masterUrl: 'a', languages: ['Telugu'] }, { masterUrl: 'b', languages: ['Hindi'] }, { masterUrl: 'c', languages: ['Telugu', 'Hindi'] },
    ], false, 'Telugu'));
    expect(refreshNote(m, t0 + 5000)).toBe('Updated: 3 sources (2 Telugu)');
    expect(refreshNote(m, t0 + 5000 + REFRESH_NOTE_MS)).toBeNull();
    expect(refreshState(m, t0 + 5000)).toBe(RefreshState.COOLDOWN);
    expect(refreshLabel(m, t0 + 5000)).toBe('Refresh again in 25s');
    expect(refreshLabel(m, t0 + REFRESH_COOLDOWN_MS)).toBe('Refresh sources');
  });
  it('no change, failed, empty, and a press in the cooldown', () => {
    const rows = [{ masterUrl: 'u1', languages: ['Telugu'] }];
    expect(refreshOutcome(new Set(['u1']), rows, false)).toBe('No new sources');
    expect(refreshOutcome(new Set(['u1']), [], true)).toBe("Couldn't refresh. Try again.");
    expect(refreshOutcome(new Set(['u1']), [], false)).toBe('No sources found yet');
    const m = refreshBlocked(refreshFinish(refreshStart(0, 30000), 2000, 'No new sources'), 10000, 30000);
    expect(refreshNote(m, 10000)).toBe('Refresh again in 20s');
  });
  it('auto-starts only when the current source had failed', () => {
    const rows = [{ masterUrl: 'u1' }];
    expect(refreshAutoStart(false, rows)).toBe(false);
    expect(refreshAutoStart(true, rows)).toBe(true);
    expect(refreshAutoStart(true, [])).toBe(false);
  });
});

describe('Player: refresh while playing keeps the stream (gap 10.3)', () => {
  const A = { id: 'a', masterUrl: 'https://h/a.m3u8', provider: 'CastleTV' };
  const B = { id: 'b', masterUrl: 'https://h/b.m3u8', provider: 'OneTouchTV' };
  it('the playing row stays listed when the new answer lacks it; B is listed', () => {
    expect(keepPlayingRow([A], [B], 'a').map((s) => s.id)).toEqual(['b', 'a']);
    expect(keepPlayingRow([A], [B, { ...A }], 'a').map((s) => s.id)).toEqual(['b', 'a']);
    expect(keepPlayingRow([A], [B], null).map((s) => s.id)).toEqual(['b']);
  });
  it('Player.jsx: no start while playing; the list is replaced keeping the playing row', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'Player.jsx'), 'utf8');
    const body = src.split('refreshRowsRef.current = (rows, answer) => {')[1].split('\n  };\n')[0];
    expect(body).toContain('if (refreshAutoStart(Boolean(resolve.error), rows))');
    expect(body).toContain('resolve.replaceSources(rows, currentSourceIdRef.current)');
    expect((body.match(/resolve\.load\(/g) || []).length).toBe(1);
    const hook = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'player', 'useResolve.js'), 'utf8');
    expect(hook).toContain('keepPlayingRow(prev, next, keepId)');
  });
});

describe('where it shows', () => {
  const CHOICES = [
    { id: 'CastleTV-0', label: 'CastleTV', quality: '1080p', source: { id: 'CastleTV-0', provider: 'CastleTV', languages: ['Telugu'] } },
  ];
  const r = (over = {}) => ({ refresh: vi.fn(), state: 'idle', label: 'Refresh sources', note: null, running: false, ...over });

  it('first row of the source list; old rows dim while refreshing', () => {
    const { container, rerender } = render(<VideoMenu choices={CHOICES} currentId="CastleTV-0" open onToggle={() => {}} refresh={r()} />);
    const items = [...container.querySelectorAll('.pmenu-item')];
    expect(items[0].getAttribute('data-action')).toBe('refresh-sources');
    expect(items[0].textContent).toContain('Refresh sources');
    expect(items[0].textContent).toContain('Current playback continues');
    expect(items[1].className).not.toContain('dim');
    rerender(<VideoMenu choices={CHOICES} currentId="CastleTV-0" open onToggle={() => {}} refresh={r({ running: true, state: 'refreshing', label: 'Refreshing…' })} />);
    const busy = [...container.querySelectorAll('.pmenu-item')];
    expect(busy[0].textContent).toContain('Refreshing…');
    expect(busy[0].querySelector('.refresh-spin')).not.toBeNull();
    expect(busy[1].className).toContain('dim');
  });

  it('failure card: Try again (primary, TV focus) and Back (owner 2026-11-24)', () => {
    document.documentElement.dataset.tv = 'true';
    const { container } = render(<PlayerError error={{ message: 'x' }} embeds={[]} headline="No sources found for RRR"
      onClose={() => {}} onRetry={() => {}} />);
    const btns = [...container.querySelectorAll('.ov-actions button')].map((b) => b.textContent);
    expect(btns).toEqual(['Try again', 'Back']);
    expect(document.activeElement?.textContent).toBe('Try again');
    expect(container.querySelector('.ov-actions .btn.primary').textContent).toBe('Try again');
  });

  it('failure view copy and TV focus', () => {
    const list = [{ id: 'a', provider: 'CastleTV', quality: '1080p', languages: ['Telugu'], masterUrl: 'u' }];
    const failed = loadingView({ now: 90000, playAt: 0, title: 'RRR', sources: list, labels: {}, firstListSize: 1, failed: true,
      attempts: [{ id: 'a', startedAt: 0, endedAt: 1, state: RowState.FAILED, reason: Reason.NO_ANSWER }] });
    expect(failed.headline).toBe("Couldn't play any source");
    expect(tvFocus(failed)).toBe('retry');
    const none = loadingView({ now: 90000, playAt: 0, title: 'RRR', sources: [], labels: {}, failed: true, attempts: [] });
    expect(none.headline).toBe('No sources found for RRR');
    expect(tvFocus(loadingView({ now: 1000, playAt: 0, title: 'RRR', sources: null, labels: {}, attempts: [] }))).toBe('details');
  });
});

