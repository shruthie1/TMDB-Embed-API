import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import PrefsButton from '../../components/PrefsPicker';
import { PREFS_EVENT, getPrefs, effectiveLangs } from '../../lib/prefs';

vi.mock('next/link', () => ({ default: ({ children, ...p }) => <a {...p}>{children}</a> }));

const dialog = () => screen.queryByRole('dialog');
const chip = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const openFromNav = () => fireEvent.click(screen.getByRole('button', { name: 'Your languages' }));
const ALL = ['Telugu', 'Tamil', 'Hindi', 'Malayalam', 'Kannada'];

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('PrefsModal', () => {
  it('never opens by itself on a first visit; every language is in use, Telugu first', () => {
    render(<PrefsButton />);
    act(() => { window.dispatchEvent(new Event('load')); vi.runAllTimers(); });
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('chitram:prefs:v1')).toBeNull();
    expect(effectiveLangs(getPrefs())).toEqual(['te', 'ta', 'hi', 'ml', 'kn']);
  });

  it('opens from the Languages button with every language selected on a first visit', () => {
    render(<PrefsButton />);
    openFromNav();
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    for (const l of ALL) expect(chip(l).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('5 selected')).toBeTruthy();
    expect([...document.querySelectorAll('.lang-opt')][0].textContent).toMatch(/^Telugu/);
    expect(screen.getByLabelText('Close')).toBeTruthy();
  });

  it('an old empty (Skip) choice also opens with every language selected', () => {
    localStorage.setItem('chitram:prefs:v1', JSON.stringify({ langs: [] }));
    render(<PrefsButton />);
    openFromNav();
    for (const l of ALL) expect(chip(l).getAttribute('aria-pressed')).toBe('true');
  });

  it('saves tap order and fires the refresh event', () => {
    const seen = [];
    const onSave = (e) => seen.push(e.detail);
    window.addEventListener(PREFS_EVENT, onSave);
    render(<PrefsButton />);
    openFromNav();
    for (const l of ALL) fireEvent.click(chip(l));  // clear all
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    expect(screen.getByText('Pick at least one language')).toBeTruthy();
    fireEvent.click(chip('Hindi'));
    fireEvent.click(chip('Telugu'));
    expect(chip('Hindi').className).toContain('on');
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    window.removeEventListener(PREFS_EVENT, onSave);

    expect(dialog()).toBeNull();
    expect(JSON.parse(localStorage.getItem('chitram:prefs:v1'))).toEqual({ langs: ['hi', 'te'] });
    expect(seen.at(-1).langs).toEqual(['hi', 'te']);
  });

  it('Cancel, Close and Escape keep the saved choice', () => {
    localStorage.setItem('chitram:prefs:v1', JSON.stringify({ langs: ['ta'] }));
    render(<PrefsButton />);
    openFromNav();
    expect(chip('Tamil').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Telugu').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip('Hindi'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeNull();
    openFromNav();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialog()).toBeNull();
    openFromNav();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(dialog()).toBeNull();
    expect(JSON.parse(localStorage.getItem('chitram:prefs:v1'))).toEqual({ langs: ['ta'] });
  });

  it('opens with focus on the dialog, and focus never toggles a tile', () => {
    localStorage.setItem('chitram:prefs:v1', JSON.stringify({ langs: ['te'] }));
    render(<PrefsButton />);
    openFromNav();
    expect(document.activeElement).toBe(dialog());
    const te = chip('Telugu');
    const hi = chip('Hindi');
    act(() => { hi.focus(); });
    expect(hi.className).not.toMatch(/\bon\b/);
    fireEvent.click(hi);
    expect(hi.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(te);
    expect(te.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('on a TV the Languages button focuses the first tile and nothing pops on load', () => {
    localStorage.setItem('chitram.tv', JSON.stringify({ v: '1', until: Date.now() + 3600e3 }));
    render(<PrefsButton />);
    act(() => { window.dispatchEvent(new Event('load')); vi.runAllTimers(); });
    expect(dialog()).toBeNull();
    openFromNav();
    expect(document.activeElement).toBe(chip('Telugu'));
  });
});
