import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { freshRowFor, useStaleRefresh } from '../../lib/player/staleRefresh';

// GET /api/streams/movie/690957, 2026-11-16: OneTouchTV signs its master for
// 60 min (hdnts exp), CastleTV for 180 min. An expired master gives 403.
const OTV = { id: 'OneTouchTV-11', provider: 'OneTouchTV', quality: 'Auto', languages: [],
  masterUrl: 'https://b/m3u8-proxy?url=old' };
const FRESH = { id: 'OneTouchTV-0', provider: 'OneTouchTV', quality: 'Auto', languages: [],
  masterUrl: 'https://b/m3u8-proxy?url=new' };

describe('freshRowFor', () => {
  it('takes the same provider row with the same quality and languages', () => {
    const tamil = { id: 'CastleTV-0', provider: 'CastleTV', quality: '720p', languages: ['Tamil'], masterUrl: 't' };
    const telugu = { id: 'CastleTV-1', provider: 'CastleTV', quality: '720p', languages: ['Telugu'], masterUrl: 'u' };
    const target = { provider: 'CastleTV', quality: '720p', languages: ['Telugu'] };
    expect(freshRowFor(target, [tamil, telugu])).toBe(telugu);
  });

  it('ignores other providers and answers null when the provider is gone', () => {
    expect(freshRowFor(OTV, [{ provider: 'CastleTV', masterUrl: 'x' }])).toBeNull();
    expect(freshRowFor(OTV, [FRESH])).toBe(FRESH);
  });
});

function setup(fetchRows, current = OTV.id) {
  const apply = vi.fn();
  const giveUp = vi.fn();
  const { result } = renderHook(() => useStaleRefresh({
    fetchRows, apply, giveUp, currentId: () => current,
  }));
  return { api: result.current, apply, giveUp };
}

describe('useStaleRefresh', () => {
  it('a stale pick plays the fresh url instead of reverting', async () => {
    const { api, apply, giveUp } = setup(async () => [FRESH]);
    expect(api.tryRefresh(OTV)).toBe(true);
    await waitFor(() => expect(apply).toHaveBeenCalledWith(OTV, FRESH));
    expect(giveUp).not.toHaveBeenCalled();
  });

  it('refreshes a row once; a second 403 goes back to the guard', async () => {
    const { api, apply } = setup(async () => [FRESH]);
    expect(api.tryRefresh(OTV)).toBe(true);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(api.tryRefresh(OTV)).toBe(false);
    api.reset();
    expect(api.tryRefresh(OTV)).toBe(true);
  });

  it('no fresh row, or a failed ask, reverts', async () => {
    const a = setup(async () => []);
    a.api.tryRefresh(OTV);
    await waitFor(() => expect(a.giveUp).toHaveBeenCalledTimes(1));
    const b = setup(async () => { throw new Error('offline'); });
    b.api.tryRefresh(OTV);
    await waitFor(() => expect(b.giveUp).toHaveBeenCalledTimes(1));
  });

  it('drops a late answer once the viewer picked something else', async () => {
    const { api, apply, giveUp } = setup(async () => [FRESH], 'CastleTV-0');
    api.tryRefresh(OTV);
    await new Promise((r) => setTimeout(r, 10));
    expect(apply).not.toHaveBeenCalled();
    expect(giveUp).not.toHaveBeenCalled();
  });

  it('never refreshes a pairing', () => {
    const { api } = setup(async () => [FRESH]);
    expect(api.tryRefresh({ ...OTV, id: 'pair-OneTouchTV-11-CastleTV-0' })).toBe(false);
    expect(api.tryRefresh({ ...OTV, hybrid: true })).toBe(false);
  });
});
