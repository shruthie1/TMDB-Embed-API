import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { resolveLive } from '../../lib/backend';
import { _resetStreamCache } from '../../lib/streamCache';
import {
  loadingView, Phase, RowState, Reason, LOADING_NO_SOURCES_MS, FAIL_COPY, tvFocus,
} from '../../lib/player/loadingModel';
import { PlayerError } from '../../components/player/overlays';

// Owner 2026-11-24: the player's loading screen must not count up forever.
// 0 playable rows from the streams call, or 45 s with 0 rows: "No sources
// found for <title>" with Try again and Back. Rows existed but all failed:
// "Couldn't play any source" with Try again and Pick a source.

afterEach(() => { cleanup(); delete document.documentElement.dataset.tv; });

const base = { playAt: 0, title: 'RRR', labels: {}, attempts: [] };

describe('repro: an empty streams answer', () => {
  it('reaches onFail (the end state), not a forever wait', async () => {
    _resetStreamCache();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, count: 0, streams: [] }) }));
    const out = await new Promise((resolve) => {
      resolveLive('movie', 990001, { clientFallback: async () => [], onDone: (d) => resolve({ ok: d }), onFail: (e) => resolve({ err: e }) });
    });
    expect(out.err).toBeTruthy();
  });
});

describe('no-sources end state', () => {
  it('45 s with no rows ends the search: no count-up, no spinner phase', () => {
    const before = loadingView({ ...base, now: LOADING_NO_SOURCES_MS - 1, sources: null });
    expect(before.phase).not.toBe(Phase.FAILED);
    const v = loadingView({ ...base, now: LOADING_NO_SOURCES_MS, sources: null });
    expect(LOADING_NO_SOURCES_MS).toBe(45000);
    expect(v.phase).toBe(Phase.FAILED);
    expect(v.noSources).toBe(true);
    expect(v.headline).toBe('No sources found for RRR');
    expect(v.showTryAgain).toBe(true);
    expect(tvFocus(v)).toBe('retry');
  });

  it('a search-phase Try again at 30 s restarts the 45 s count', () => {
    const checks = [{ id: 'check:server', label: 'Chitram server', startedAt: 30000, endedAt: null }];
    expect(loadingView({ ...base, now: 60000, sources: null, checks }).phase).not.toBe(Phase.FAILED);
    expect(loadingView({ ...base, now: 75000, sources: null, checks }).phase).toBe(Phase.FAILED);
  });

  it('the streams call finished with 0 rows', () => {
    const v = loadingView({ ...base, now: 3000, sources: [], failed: true });
    expect(v.noSources).toBe(true);
    expect(v.headline).toBe('No sources found for RRR');
  });

  it('rows existed but all failed', () => {
    const list = [{ id: 'a', provider: 'CastleTV', quality: '1080p', languages: ['Telugu'], masterUrl: 'u' }];
    const v = loadingView({ ...base, now: 90000, sources: list, firstListSize: 1, failed: true,
      attempts: [{ id: 'a', startedAt: 0, endedAt: 1, state: RowState.FAILED, reason: Reason.NO_ANSWER }] });
    expect(v.noSources).toBe(false);
    expect(v.headline).toBe(FAIL_COPY.COULDNT_PLAY);
    expect(FAIL_COPY.COULDNT_PLAY).toBe("Couldn't play any source");
  });

  it('a list that lands after 45 s is not the end card', () => {
    const list = [{ id: 'a', provider: 'CastleTV', quality: '1080p', languages: ['Telugu'], masterUrl: 'u' }];
    const v = loadingView({ ...base, now: 60000, sources: list, firstListSize: 1 });
    expect(v.phase).not.toBe(Phase.FAILED);
  });
});

describe('end card buttons', () => {
  it('no sources: Try again (TV focus) and Back', () => {
    document.documentElement.dataset.tv = 'true';
    const onRetry = vi.fn(); const onClose = vi.fn();
    const { container } = render(<PlayerError error={{ message: 'x' }} embeds={[]} headline="No sources found for RRR"
      onClose={onClose} onRetry={onRetry} />);
    const btns = [...container.querySelectorAll('.ov-actions button')];
    expect(btns.map((b) => b.textContent)).toEqual(['Try again', 'Back']);
    expect(document.activeElement?.textContent).toBe('Try again');
    fireEvent.click(btns[0]);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('all failed: Try again and Pick a source', () => {
    const onPick = vi.fn();
    const { container } = render(<PlayerError error={{ message: 'x' }} embeds={[]} headline="Couldn't play any source"
      onClose={() => {}} onRetry={() => {}} onPick={onPick} />);
    const btns = [...container.querySelectorAll('.ov-actions button')];
    expect(btns.map((b) => b.textContent)).toEqual(['Try again', 'Pick a source']);
    fireEvent.click(btns[1]);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
