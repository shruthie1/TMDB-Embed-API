import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';

vi.mock('next/link', () => ({ default: ({ children, prefetch: _p, ...p }) => <a {...p}>{children}</a> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, prefetch() {} }), usePathname: () => '/' }));
vi.mock('../../lib/prefetch', () => ({ warmContinueWatching() {}, intentProps: () => ({}) }));

// Prod repro (clean Chrome, 2026-11-22): with chitram:prefs:v1 = {"langs":["te"]}
// the home page threw React #425/#418/#423 and the dev build named the row
// "See all" href (server lang=te,ta,hi,ml,kn, client lang=te). The whole
// document was re-rendered on the client.
const t = (id) => ({ tmdbId: id, mediaType: 'movie', title: `T${id}`, poster: null,
                     backdrop: `/b${id}.jpg`, year: 2025, originalLang: 'te' });

let container;
beforeEach(() => {
  vi.resetModules();   // fresh module state: a real page load starts with none
  localStorage.clear();
  localStorage.setItem('chitram:prefs:v1', JSON.stringify({ langs: ['te'] }));
  let n = 0;
  globalThis.fetch = vi.fn(async () => {
    const base = 100 * n++;
    return { ok: true, status: 200, json: async () => ({ titles: Array.from({ length: 30 }, (_, i) => t(base + i + 1)) }) };
  });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => { container.remove(); delete globalThis.fetch; vi.unstubAllGlobals(); });

describe('Home hydration', () => {
  it('hydrates server HTML without a mismatch when a language choice is stored', async () => {
    const { default: Home } = await import('../../app/page');
    // Server: no localStorage.
    vi.stubGlobal('localStorage', undefined);
    const html = renderToString(<Home />);
    vi.unstubAllGlobals();
    expect(localStorage.getItem('chitram:prefs:v1')).toContain('te');

    container.innerHTML = html;
    const errors = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let root;
    await act(async () => {
      root = hydrateRoot(container, <Home />, { onRecoverableError: (e) => errors.push(e.message) });
    });
    spy.mockRestore();
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(errors).toEqual([]);

    // After mount the stored choice drives the rows.
    const hrefs = [...container.querySelectorAll('a')].map(a => a.getAttribute('href') || '');
    expect(hrefs.some(h => h.includes('lang=te') && !h.includes('lang=te,'))).toBe(true);
    expect(hrefs.some(h => h.includes('lang=te,ta'))).toBe(false);
    await act(async () => root.unmount());
  });

  it('reads stored prefs at once on a later client mount (Back to home)', async () => {
    const { default: Home } = await import('../../app/page');
    const { render, cleanup } = await import('@testing-library/react');
    await act(async () => { render(<Home />); });
    cleanup();
    let view;
    // The second mount's first render already uses the stored choice.
    const { getPrefs } = await import('../../lib/prefs');
    expect(getPrefs().langs).toEqual(['te']);
    await act(async () => { view = render(<Home />); });
    const hrefs = [...view.container.querySelectorAll('a')].map(a => a.getAttribute('href') || '');
    expect(hrefs.some(h => h.includes('lang=te,ta'))).toBe(false);
    cleanup();
  });
});
