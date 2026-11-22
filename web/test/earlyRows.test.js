// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EARLY_TITLE_SCRIPT, EARLY_ROWS_SCRIPT, EARLY_ROW_KINDS, earlyRowUrl, takeEarly } from '../lib/earlyRows';
import { fetchRow, fetchTitleFull, heroBackdrop } from '../lib/api';
import { prefsQuery, getPrefs } from '../lib/prefs';

const run = () => { new Function(EARLY_ROWS_SCRIPT)(); };   // eslint-disable-line no-new-func

beforeEach(() => { localStorage.clear(); delete window.__chitramEarly; });

describe('early home rows', () => {
  it('requests the same urls fetchRow builds, with no stored choice', async () => {
    const seen = [];
    globalThis.fetch = vi.fn(async (u) => { seen.push(u); return { ok: true, status: 200, json: async () => ({ titles: [{ id: u }] }) }; });
    run();
    expect(seen).toEqual(EARLY_ROW_KINDS.map(k => `/api/rows/${k}`));
    // fetchRow takes the early answer: no second request.
    const res = await fetchRow('top10', { query: prefsQuery(getPrefs()) });
    expect(res).toEqual({ ok: true, status: 200, body: { titles: [{ id: '/api/rows/top10' }] } });
    expect(seen).toHaveLength(3);
    // Taken once: a retry fetches again.
    await fetchRow('top10', { query: '' });
    expect(seen).toHaveLength(4);
  });

  it('matches a stored language choice, cleaned the same way', async () => {
    localStorage.setItem('chitram:prefs:v1', JSON.stringify({ langs: ['TE', 'xx', 'hi', 'te'] }));
    const seen = [];
    globalThis.fetch = vi.fn(async (u) => { seen.push(u); return { ok: true, status: 200, json: async () => ({}) }; });
    run();
    const q = prefsQuery(getPrefs());
    expect(q).toBe('langs=te%2Chi');
    expect(seen[0]).toBe(`/api/rows/top10?${q}`);
    expect(seen[0]).toBe(earlyRowUrl('top10', ['te', 'hi']));
    expect(takeEarly(`/api/rows/recent?${q}`)).not.toBeNull();
    expect(takeEarly(`/api/rows/recent?${q}`)).toBeNull();
  });

  it('starts the first Top 10 backdrop at high priority, with the hero url', async () => {
    const made = [];
    const Orig = globalThis.Image;
    globalThis.Image = class { constructor() { made.push(this); } };
    window.matchMedia = () => ({ matches: true });
    globalThis.fetch = vi.fn(async (u) => ({ ok: true, status: 200,
      json: async () => (u.includes('top10') ? { titles: [{ backdrop: null }, { backdrop: '/b1.jpg' }] } : {}) }));
    run();
    await fetchRow('top10', {});
    globalThis.Image = Orig;
    expect(made).toHaveLength(1);
    expect(made[0].fetchPriority).toBe('high');
    expect(made[0].src).toBe(heroBackdrop('/b1.jpg', true));
  });

  it('a failed early request falls back to a normal fetch', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => { if (n++ === 0) throw new Error('offline'); return { ok: true, status: 200, json: async () => ({ titles: [] }) }; });
    run();
    const res = await fetchRow('top10', {});
    expect(res.ok).toBe(true);
  });

  it('title page: requests the full record fetchTitleFull uses and starts its backdrop', async () => {
    const seen = [];
    const made = [];
    const Orig = globalThis.Image;
    globalThis.Image = class { constructor() { made.push(this); } };
    window.matchMedia = () => ({ matches: false });
    globalThis.fetch = vi.fn(async (u) => { seen.push(u); return { ok: true, status: 200, json: async () => ({ title: 'X', backdrop: '/bx.jpg' }) }; });
    window.history.replaceState(null, '', '/title/movie/1057265');
    new Function(EARLY_TITLE_SCRIPT)();   // eslint-disable-line no-new-func
    const res = await fetchTitleFull('movie', '1057265');
    globalThis.Image = Orig;
    expect(seen).toEqual(['/api/title/movie/1057265/full']);
    expect(res).toEqual({ ok: true, status: 200, body: { title: 'X', backdrop: '/bx.jpg' } });
    expect(made[0].src).toBe(heroBackdrop('/bx.jpg', false));
    expect(made[0].fetchPriority).toBe('high');
    // Not a title path: nothing requested.
    window.history.replaceState(null, '', '/title/movie/abc');
    new Function(EARLY_TITLE_SCRIPT)();   // eslint-disable-line no-new-func
    expect(seen).toHaveLength(1);
  });
});
