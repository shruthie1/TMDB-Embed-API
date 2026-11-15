// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readOverride } from '../lib/dpad.js';

// The real helper against the real URL: ?tv=1 turns TV mode on and is
// remembered; ?tv=0 turns it off; with no param the stored choice wins.
const at = (search) => window.history.replaceState(null, '', '/' + search);
const sniffNo = () => false;
const sniffYes = () => true;

beforeEach(() => { localStorage.clear(); at(''); });

describe('?tv= query', () => {
  it('?tv=1 turns TV mode on and remembers it without the param', () => {
    at('?tv=1');
    expect(readOverride('chitram.tv', 'tv', sniffNo)).toBe(true);
    at('');
    expect(readOverride('chitram.tv', 'tv', sniffNo)).toBe(true);
  });
  it('?tv=0 turns TV mode off even on a TV-looking device', () => {
    at('?tv=0');
    expect(readOverride('chitram.tv', 'tv', sniffYes)).toBe(false);
    at('');
    expect(readOverride('chitram.tv', 'tv', sniffYes)).toBe(false);
  });
  it('uses the device sniff when nothing was set', () => {
    expect(readOverride('chitram.tv', 'tv', sniffNo)).toBe(false);
    expect(readOverride('chitram.tv', 'tv', sniffYes)).toBe(true);
  });
  it('ignores other values', () => {
    at('?tv=yes');
    expect(readOverride('chitram.tv', 'tv', sniffNo)).toBe(false);
    expect(localStorage.getItem('chitram.tv')).toBe(null);
  });
});
