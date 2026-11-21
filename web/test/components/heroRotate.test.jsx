import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import Hero from '../../components/Hero';

// A tap on a dot or button focuses it and on a phone that focus never blurs,
// so pausing on any focus stopped the carousel for good. Only keyboard / D-pad
// focus (:focus-visible) and a real mouse hover pause it.
const titles = [1, 2, 3].map(n => ({ tmdbId: n, mediaType: 'movie', title: `T${n}`, backdrop: `/b${n}.jpg` }));
const active = c => [...c.querySelectorAll('.hero-dot')].findIndex(d => d.classList.contains('on'));
const tick = ms => act(() => { vi.advanceTimersByTime(ms); });
// jsdom has no PointerEvent (so no pointerType) and treats :focus-visible as
// :focus. Give it both, so each test states which kind of focus it means.
class FakePointerEvent extends MouseEvent {
  constructor(type, init = {}) { super(type, init); this.pointerType = init.pointerType || ''; }
}
const focusVisible = visible => {
  const real = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (sel) {
    return sel === ':focus-visible' ? visible : real.call(this, sel);
  });
};

beforeEach(() => { vi.useFakeTimers(); globalThis.PointerEvent ??= FakePointerEvent; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Hero auto-rotate', () => {
  it('keeps rotating after a tap focuses a dot', () => {
    const { container } = render(<Hero titles={titles} />);
    const dot = container.querySelectorAll('.hero-dot')[1];
    focusVisible(false); // what Chrome reports for a tap-focused button
    // Mobile Chrome's order for one tap: pointer events, then the emulated
    // mouse events, with focus landing on mousedown. No mouseleave, no blur.
    fireEvent.pointerOver(dot, { pointerType: 'touch' });
    fireEvent.pointerDown(dot, { pointerType: 'touch' });
    fireEvent.pointerUp(dot, { pointerType: 'touch' });
    fireEvent.mouseOver(dot);
    fireEvent.mouseDown(dot);
    act(() => { dot.focus(); });
    fireEvent.mouseUp(dot);
    fireEvent.click(dot);
    expect(active(container)).toBe(1);
    expect(container.querySelector('.home-hero').hasAttribute('data-paused')).toBe(false);
    tick(8000);
    expect(active(container)).toBe(2);
  });

  it('pauses for keyboard focus and resumes on blur', () => {
    const { container } = render(<Hero titles={titles} />);
    const dot = container.querySelectorAll('.hero-dot')[0];
    focusVisible(true);
    act(() => { dot.focus(); });
    tick(9000);
    expect(active(container)).toBe(0);
    act(() => { dot.blur(); });
    tick(8000);
    expect(active(container)).toBe(1);
  });

  it('pauses while a mouse hovers, not for touch', () => {
    const { container } = render(<Hero titles={titles} />);
    const hero = container.querySelector('.home-hero');
    fireEvent.pointerEnter(hero, { pointerType: 'touch' });
    expect(hero.hasAttribute('data-paused')).toBe(false);
    fireEvent.pointerEnter(hero, { pointerType: 'mouse' });
    expect(hero.hasAttribute('data-paused')).toBe(true);
    fireEvent.pointerLeave(hero, { pointerType: 'mouse' });
    expect(hero.hasAttribute('data-paused')).toBe(false);
    tick(8000);
    expect(active(container)).toBe(1);
  });
});
