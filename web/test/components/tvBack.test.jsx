import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDpad } from '../../lib/dpad';

/**
 * TV Back (Backspace) wired through initDpad, in a real DOM.
 *
 * jsdom has no layout, so offsetParent is always null and every element would
 * look unreachable. It is stubbed to the parent for these tests. jsdom also
 * reports opacity as "", which reachable() reads as 0, so dialogs set it.
 */
let teardown;
const press = (key, keyCode) => {
  const e = new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true });
  (document.activeElement || document.body).dispatchEvent(e);
  return e;
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent',
    { configurable: true, get() { return this.parentNode; } });
  localStorage.setItem('chitram.tv', JSON.stringify({ v: '1', until: Date.now() + 60000 }));
  window.history.replaceState(null, '', '/title/movie/1');
  document.body.innerHTML = '';
  teardown = initDpad();
});
afterEach(() => {
  teardown();
  localStorage.clear();
  delete window.Hisense_Exit;
  vi.restoreAllMocks();
});

describe('TV Back key outside the player', () => {
  it('sends Escape to an open dialog instead of leaving the page', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true" style="opacity:1"><button data-focus>x</button></div>';
    const back = vi.spyOn(window.history, 'back');
    const seen = [];
    const onEsc = (e) => seen.push(e.key);
    window.addEventListener('keydown', onEsc);
    const e = press('Backspace', 8);
    window.removeEventListener('keydown', onEsc);
    expect(seen).toContain('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(back).not.toHaveBeenCalled();
  });

  it('goes back one page when nothing is open', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    window.history.pushState(null, '', '/title/movie/2');
    press('Backspace', 8);
    expect(back).toHaveBeenCalledOnce();
  });

  it('leaves Backspace to a text field', () => {
    document.body.innerHTML = '<input />';
    document.querySelector('input').focus();
    const back = vi.spyOn(window.history, 'back');
    const e = press('Backspace', 8);
    expect(e.defaultPrevented).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });

  it('stands down while the player is open, which handles its own Back', () => {
    document.body.innerHTML = '<div class="player"></div>';
    const back = vi.spyOn(window.history, 'back');
    press('Backspace', 8);
    expect(back).not.toHaveBeenCalled();
  });

  it('on the home page of a non-VIDAA TV, does nothing', () => {
    window.history.replaceState(null, '', '/');
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    const e = press('Backspace', 8);
    expect(close).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('on the home page of a VIDAA TV, calls Hisense_Exit', () => {
    window.history.replaceState(null, '', '/');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 Chrome/111.0.5563.146 Odin/111.5563.5.1 Safari/537.36 VIDAA/9.0(Hisense;SmartTV;;)');
    window.Hisense_Exit = vi.fn();
    press('Backspace', 8);
    expect(window.Hisense_Exit).toHaveBeenCalledOnce();
  });
});
