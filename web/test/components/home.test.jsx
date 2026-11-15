import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('next/link', () => ({ default: ({ children, prefetch: _p, ...p }) => <a {...p}>{children}</a> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, prefetch() {} }), usePathname: () => '/' }));
vi.mock('../../lib/prefetch', () => ({ warmContinueWatching() {}, intentProps: () => ({}) }));

import Home from '../../app/page';

const t = (id) => ({ tmdbId: id, mediaType: 'movie', title: `T${id}`, poster: null,
                     backdrop: `/b${id}.jpg`, year: 2025, originalLang: 'te' });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('chitram:prefs:v1', JSON.stringify({ langs: ['te', 'hi'] }));
  // Each row answers with 30 titles that overlap the previous row's by 20,
  // so a page without cross-row dedupe would repeat most of them.
  let n = 0;
  globalThis.fetch = vi.fn(async () => {
    const base = 10 * n++;
    return { ok: true, status: 200,
             json: async () => ({ titles: Array.from({ length: 30 }, (_, i) => t(base + i + 1)) }) };
  });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => { cleanup(); delete globalThis.fetch; });

describe('Home', () => {
  it('renders each section once and each title once across rows', async () => {
    let view;
    await act(async () => { view = render(<Home />); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    const labels = [...view.container.querySelectorAll('.row-label')].map(e => e.textContent);
    expect(labels.length, labels.join(' / ')).toBeGreaterThan(4);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('Top 10 in India today');
    const hrefs = [...view.container.querySelectorAll('section a.card')].map(a => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
