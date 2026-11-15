import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import PrefsButton from '../../components/PrefsPicker';
import { PREFS_EVENT } from '../../lib/prefs';

vi.mock('next/link', () => ({ default: ({ children, ...p }) => <a {...p}>{children}</a> }));

const dialog = () => screen.getByRole('dialog', { hidden: true });
const isOpen = () => dialog().closest('.fpanel').classList.contains('open');

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); });

describe('PrefsModal', () => {
  it('opens by itself on a first visit and is not dismissed by an outside tap', () => {
    render(<PrefsButton />);
    expect(isOpen()).toBe(true);
    fireEvent.click(document.body.querySelector('.sheet-scrim'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(isOpen()).toBe(true);
    // No close (X) button on the first visit: Save or Use defaults only.
    expect(screen.queryByLabelText('Close')).toBeNull();
  });

  it('saves tap order, fires the refresh event, and never pops again', () => {
    const seen = [];
    const onSave = (e) => seen.push(e.detail);
    window.addEventListener(PREFS_EVENT, onSave);
    const first = render(<PrefsButton />);
    // Clear the defaults, then pick Hindi then Telugu.
    // Selected chips carry their rank ("2. Tamil"), which renumbers as they go.
    for (const lang of ['Telugu', 'Tamil', 'Hindi', 'Malayalam', 'Kannada']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^\\d\\. ${lang}$`), hidden: true }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Hindi', hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Telugu', hidden: true }));
    expect(screen.getByRole('button', { name: '1. Hindi', hidden: true })).toBeTruthy();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save', hidden: true })); });
    window.removeEventListener(PREFS_EVENT, onSave);

    expect(isOpen()).toBe(false);
    expect(JSON.parse(localStorage.getItem('chitram:prefs:v1'))).toEqual({ langs: ['hi', 'te'] });
    expect(seen.at(-1).langs).toEqual(['hi', 'te']);
    first.unmount();

    render(<PrefsButton />);
    expect(isOpen()).toBe(false);
  });

  it('reopens from the header button, with a close option', () => {
    localStorage.setItem('chitram:prefs:v1', JSON.stringify({ langs: ['ta'] }));
    render(<PrefsButton />);
    expect(isOpen()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Your languages' }));
    expect(isOpen()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use defaults', hidden: true }));
    expect(JSON.parse(localStorage.getItem('chitram:prefs:v1')))
      .toEqual({ langs: ['te', 'ta', 'hi', 'ml', 'kn'] });
  });
});
