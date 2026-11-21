import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import PrefsButton from '../../components/PrefsPicker';
import { PREFS_EVENT } from '../../lib/prefs';

vi.mock('next/link', () => ({ default: ({ children, ...p }) => <a {...p}>{children}</a> }));

const dialog = () => screen.queryByRole('dialog');
const chip = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const firstVisit = () => { act(() => { vi.runAllTimers(); }); };

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('PrefsModal', () => {
  it('opens after load on a first visit, with Telugu preselected, and is sticky', () => {
    render(<PrefsButton />);
    expect(dialog()).toBeNull();           // not before the page has painted
    firstVisit();
    const d = dialog();
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(chip('Telugu').getAttribute('aria-pressed')).toBe('true');
    for (const l of ['Tamil', 'Hindi', 'Malayalam', 'Kannada']) {
      expect(chip(l).getAttribute('aria-pressed')).toBe('false');
    }
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(false);
    expect(screen.queryByText('Pick at least one language')).toBeNull();
    // Clearing the default still needs a pick before Save.
    fireEvent.click(chip('Telugu'));
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    expect(screen.getByText('Pick at least one language')).toBeTruthy();
    fireEvent.click(document.body.querySelector('.lang-modal-backdrop'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialog()).not.toBeNull();
    expect(screen.queryByLabelText('Close')).toBeNull();
  });

  it('saves tap order, fires the refresh event, and never pops again', () => {
    const seen = [];
    const onSave = (e) => seen.push(e.detail);
    window.addEventListener(PREFS_EVENT, onSave);
    const first = render(<PrefsButton />);
    firstVisit();
    fireEvent.click(chip('Telugu'));       // clear the preselected default
    fireEvent.click(chip('Hindi'));
    fireEvent.click(chip('Telugu'));
    expect(chip('Hindi').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Hindi').className).toContain('on');
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    window.removeEventListener(PREFS_EVENT, onSave);

    expect(dialog()).toBeNull();
    expect(JSON.parse(localStorage.getItem('chitram:prefs:v1'))).toEqual({ langs: ['hi', 'te'] });
    expect(seen.at(-1).langs).toEqual(['hi', 'te']);
    first.unmount();

    render(<PrefsButton />);
    firstVisit();
    expect(dialog()).toBeNull();
  });

  it('Skip stores an empty choice, meaning all languages', () => {
    render(<PrefsButton />);
    firstVisit();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(dialog()).toBeNull();
    expect(JSON.parse(localStorage.getItem('chitram:prefs:v1'))).toEqual({ langs: [] });
  });

  it('reopens from the header button with the saved choice and a close option', () => {
    localStorage.setItem('chitram:prefs:v1', JSON.stringify({ langs: ['ta'] }));
    render(<PrefsButton />);
    firstVisit();
    expect(dialog()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Your languages' }));
    expect(chip('Tamil').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialog()).toBeNull();
  });

  it('opens with every tile in the same state and focus on the dialog, not a tile', () => {
    render(<PrefsButton />);
    firstVisit();
    const tiles = [...document.querySelectorAll('.lang-opt')];
    expect(tiles).toHaveLength(5);
    const [te, ...rest] = tiles;
    expect(te.textContent).toMatch(/^Telugu/);
    expect(te.getAttribute('aria-pressed')).toBe('true');
    expect(te.className).toMatch(/\bon\b/);
    expect(new Set(rest.map(t => t.className)).size).toBe(1);
    expect(rest.every(t => t.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(document.activeElement).toBe(dialog());
  });

  it('selecting toggles aria-pressed and the selected class; focus never does', () => {
    render(<PrefsButton />);
    firstVisit();
    const te = chip('Telugu');
    const hi = chip('Hindi');
    act(() => { hi.focus(); });
    expect(hi.className).not.toMatch(/\bon\b/);
    expect(hi.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(hi);
    expect(hi.className).toMatch(/\bon\b/);
    expect(hi.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('2 selected')).toBeTruthy();
    act(() => { te.focus(); });
    expect(te.className).toMatch(/\bon\b/);
    expect(chip('Tamil').className).not.toMatch(/\bon\b/);
    fireEvent.click(te);
    expect(te.className).not.toMatch(/\bon\b/);
    expect(te.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('1 selected')).toBeTruthy();
  });
  it('on a TV first visit focuses Save, so one OK accepts Telugu; the header reopen focuses the first tile', () => {
    const tv = () => localStorage.setItem('chitram.tv', JSON.stringify({ v: '1', until: Date.now() + 3600e3 }));
    tv();
    const first = render(<PrefsButton />);
    firstVisit();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(chip('Telugu').getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(save);
    act(() => { fireEvent.click(save); });
    expect(JSON.parse(localStorage.getItem('chitram:prefs:v1'))).toEqual({ langs: ['te'] });
    first.unmount();

    tv();
    render(<PrefsButton />);
    firstVisit();
    fireEvent.click(screen.getByRole('button', { name: 'Your languages' }));
    expect(document.activeElement).toBe(chip('Telugu'));
  });
});
