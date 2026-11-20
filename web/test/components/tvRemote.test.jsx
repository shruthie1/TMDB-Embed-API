import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { initDpad } from '../../lib/dpad';
import { tvPlayerKey } from '../../lib/tvKeys';

/**
 * TV remote behaviour (2026-11-20, Hisense VIDAA report: "the player is built
 * for a mouse", "cannot see what is focused").
 *
 * jsdom has no layout, so each element carries its box in data-r
 * ("left,top,width,height") and getBoundingClientRect reads it. offsetParent
 * and getComputedStyle are stubbed so reachable() sees a visible page.
 */

describe('tvPlayerKey: the remote model inside the player', () => {
  const k = (key, controlsVisible, focusInBar) => tvPlayerKey({ key, controlsVisible, focusInBar });

  it('with the bar hidden, Left/Right seek and OK toggles', () => {
    expect(k('ArrowLeft', false, false)).toBe('rewind');
    expect(k('ArrowRight', false, false)).toBe('forward');
    expect(k('Enter', false, false)).toBe('toggle');
  });

  it('with the bar hidden, Up/Down bring it up with focus inside', () => {
    expect(k('ArrowUp', false, false)).toBe('enter-bar');
    expect(k('ArrowDown', false, false)).toBe('enter-bar');
  });

  it('with focus on a visible control, every key belongs to the bar', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter']) {
      expect(k(key, true, true), key).toBe(null);
    }
  });

  it('focus left on a faded-out control does not count as in the bar', () => {
    // Otherwise Left/Right walk invisible buttons instead of seeking.
    expect(k('ArrowRight', false, true)).toBe('forward');
  });

  it('bar showing but nothing in it focused: still seeks, Up enters the bar', () => {
    expect(k('ArrowLeft', true, false)).toBe('rewind');
    expect(k('ArrowUp', true, false)).toBe('enter-bar');
  });

  it('leaves other keys alone', () => {
    expect(k('Backspace', false, false)).toBe(null);
    expect(k('m', false, false)).toBe(null);
  });
});

describe('D-pad geometry', () => {
  let teardown;
  const press = (key) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(e);
    return e;
  };
  const html = (s) => {
    document.body.innerHTML = s;
    for (const el of document.querySelectorAll('[data-r]')) {
      const [left, top, width, height] = el.dataset.r.split(',').map(Number);
      el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height });
    }
  };
  const focused = () => document.activeElement?.id || 'BODY';

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent',
      { configurable: true, get() { return this.parentNode; } });
    vi.spyOn(window, 'getComputedStyle').mockReturnValue(
      { opacity: '1', visibility: 'visible', pointerEvents: 'auto' });
    Element.prototype.scrollIntoView = () => {};
    localStorage.setItem('chitram.tv', JSON.stringify({ v: '1', until: Date.now() + 60000 }));
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 });
    teardown = initDpad();
  });
  afterEach(() => { teardown(); localStorage.clear(); vi.restoreAllMocks(); });

  // A title page: header group, back link, hero actions (not grouped), cast rail.
  const titlePage = `
    <header data-focus-group="">
      <a id="logo" href="#" data-focus="" data-r="40,4,160,56">logo</a>
      <a id="search" href="#" data-focus="" data-r="1440,10,90,44">Search</a>
      <a id="langs" href="#" data-focus="" data-r="1750,10,130,44">Langs</a>
    </header>
    <button id="back" data-focus="" data-r="45,65,60,36">Back</button>
    <button id="play" class="btn primary" data-focus="" data-r="240,130,110,56">Play</button>
    <button id="mylist" class="btn" data-focus="" data-r="370,130,110,56">My list</button>
    <div data-rail="">
      <a id="c1" href="#" data-focus="" data-r="40,700,110,180">c1</a>
      <a id="c2" href="#" data-focus="" data-r="170,700,110,180">c2</a>
      <a id="c3" href="#" data-focus="" data-r="1960,700,110,180">c3 (off right)</a>
    </div>`;

  it('first press on a fresh page lands on the main action, not the logo', () => {
    html(titlePage);
    press('ArrowDown');
    expect(focused()).toBe('play');
  });

  it('Down from Back reaches Play instead of skipping to the next group', () => {
    html(titlePage);
    document.getElementById('back').focus();
    press('ArrowDown');
    expect(focused()).toBe('play');
  });

  it('Right from the last header link stays on the header line', () => {
    html(titlePage);
    document.getElementById('langs').focus();
    press('ArrowRight');
    expect(focused()).toBe('langs');
  });

  // Home: a side rail, two rows of cards, each row with a "See all".
  const home = `
    <nav data-nav="" data-focus-group="">
      <a id="n-search" href="#" data-focus="" data-r="22,400,68,64">Search</a>
      <a id="n-home" class="on" href="#" data-focus="" data-r="22,472,68,64">Home</a>
      <a id="n-browse" href="#" data-focus="" data-r="22,544,68,64">Browse</a>
    </nav>
    <section class="row-sec">
      <div class="row-head"><a id="more1" class="see-all" href="#" data-focus="" data-r="1700,100,120,40">See all</a></div>
      <div data-rail="">
        <a id="a1" href="#" data-focus="" data-r="160,150,220,330">a1</a>
        <a id="a2" href="#" data-focus="" data-r="396,150,220,330">a2</a>
        <a id="a3" href="#" data-focus="" data-r="1632,150,220,330">a3</a>
      </div>
    </section>
    <section class="row-sec">
      <div class="row-head"><a id="more2" class="see-all" href="#" data-focus="" data-r="1700,540,120,40">See all</a></div>
      <div data-rail="">
        <a id="b1" href="#" data-focus="" data-r="160,600,220,330">b1</a>
        <a id="b2" href="#" data-focus="" data-r="396,600,220,330">b2</a>
        <a id="b3" href="#" data-focus="" data-r="1632,600,220,330">b3</a>
      </div>
    </section>`;

  it('Down from a card goes to the card below it, not to See all', () => {
    html(home);
    document.getElementById('a3').focus();
    press('ArrowDown');
    expect(focused()).toBe('b3');
    press('ArrowUp');
    expect(focused()).toBe('a3');
    document.getElementById('a2').focus();
    press('ArrowDown');
    expect(focused()).toBe('b2');
  });

  it('the column holds across rows even after visiting another column', () => {
    html(home);
    document.getElementById('b1').focus();
    press('ArrowUp');                     // a1
    press('ArrowRight');                  // a2
    press('ArrowDown');
    expect(focused()).toBe('b2');        // not the remembered b1
  });

  it('Left from the first card opens the side rail on the current page; Right returns', () => {
    html(home);
    document.getElementById('b1').focus();
    press('ArrowLeft');
    expect(focused()).toBe('n-home');
    press('ArrowUp');
    expect(focused()).toBe('n-search');
    press('ArrowRight');
    expect(focused()).toBe('b1');
  });

  it('Down from the page never lands in the side rail', () => {
    html(home);
    document.getElementById('a1').focus();
    press('ArrowDown');
    expect(focused()).toBe('b1');
  });

  it('Right from the last card of a row reaches its See all', () => {
    html(home);
    document.getElementById('a3').focus();
    press('ArrowRight');
    expect(focused()).toBe('more1');
  });

  it('a key the player already used is not also a focus move', () => {
    html(titlePage);
    document.getElementById('play').focus();
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    e.preventDefault();
    document.activeElement.dispatchEvent(e);
    expect(focused()).toBe('play');
  });

  it('Up/Down leave a one-line search field; Left/Right stay in it', () => {
    html(`
      <input id="q" type="search" data-focus="" data-r="90,70,1700,48" />
      <a id="r1" href="#" data-focus="" data-r="90,200,220,380">result</a>`);
    document.getElementById('q').focus();
    press('ArrowRight');
    expect(focused()).toBe('q');
    press('ArrowDown');
    expect(focused()).toBe('r1');
  });

  it('an open menu holds focus until it is closed', () => {
    html(`
      <div role="dialog" aria-modal="true">
        <button id="close" data-focus="" data-r="1800,20,56,56">x</button>
        <div role="menu" data-r="1400,300,400,400">
          <button id="m1" data-focus="" data-r="1400,300,400,56">Off</button>
          <button id="m2" data-focus="" data-r="1400,360,400,56">English</button>
        </div>
        <button id="gear" data-focus="" data-r="1800,900,56,56">gear</button>
      </div>`);
    document.getElementById('m1').focus();
    press('ArrowUp');
    expect(focused()).toBe('m1');
    press('ArrowDown');
    expect(focused()).toBe('m2');
    press('ArrowDown');
    expect(focused()).toBe('m2');
  });
});

describe('PlayerControls on a remote', () => {
  vi.mock('../../components/Icon', () => ({ default: () => null }));
  let PlayerControls;
  beforeEach(async () => {
    window.matchMedia = (q) => ({ matches: false, media: q,
      addEventListener() {}, removeEventListener() {} });
    ({ default: PlayerControls } = await import('../../components/PlayerControls'));
  });

  const setup = (props) => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
    const onMenuChange = vi.fn();
    const subs = [{ id: 'en', name: 'English' }];
    const r = render(<PlayerControls videoRef={{ current: video }} title="RRR" visible
      onMenuChange={onMenuChange} subs={subs} tv {...props} />);
    return { ...r, onMenuChange, video, subs };
  };

  it('OK on Settings moves focus into the sheet', () => {
    const { container } = setup({});
    const gear = container.querySelector('[aria-label="Settings"]');
    gear.focus();
    fireEvent.click(gear);
    const sheet = container.querySelector('.pmenu-sheet');
    expect(sheet).toBeTruthy();
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(document.activeElement.classList.contains('icon-btn')).toBe(false);
  });

  it("the player's Back closes the sheet and focus returns to Settings", () => {
    const { container, rerender, onMenuChange, subs } = setup({ menuOpen: true });
    const gear = container.querySelector('[aria-label="Settings"]');
    gear.focus();
    fireEvent.click(gear);
    expect(container.querySelector('.pmenu-sheet')).toBeTruthy();
    // Player.jsx handles Back by clearing its menuOpen flag.
    act(() => {
      rerender(<PlayerControls videoRef={{ current: document.createElement('video') }} title="RRR"
        visible onMenuChange={onMenuChange} subs={subs} tv menuOpen={false} />);
    });
    expect(container.querySelector('.pmenu-sheet')).toBeNull();
    expect(document.activeElement).toBe(gear);
  });

  it('the play button is the bar entry point', () => {
    const { container } = setup({});
    const primary = container.querySelector('.pctl [data-primary]');
    expect(primary?.getAttribute('aria-label')).toMatch(/Play|Pause/);
  });

  it('OK on the seek bar toggles playback', () => {
    const { container, video } = setup({});
    video.play = vi.fn(() => Promise.resolve());
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    const bar = container.querySelector('.pctl-scrub');
    fireEvent.keyDown(bar, { key: 'Enter' });
    expect(video.play).toHaveBeenCalled();
  });
});
