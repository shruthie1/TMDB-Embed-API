import { describe, it, expect, beforeEach } from 'vitest';
import { SIZES, getSubPrefs } from '../lib/subtitles';

// Small at 0.62 still read too big. Small is 0.5, and a Small saved at 0.62
// keeps its name so the Small button stays highlighted.
let store;
beforeEach(() => {
  store = {};
  globalThis.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
});

describe('subtitle size presets', () => {
  it('Small is 0.5', () => {
    expect(SIZES.find(s => s.label === 'Small').key).toBe(0.5);
  });

  it('a Small saved at 0.62 maps to the new Small', () => {
    store['chitram:subs:v1'] = JSON.stringify({ scale: 0.62 });
    expect(getSubPrefs().scale).toBe(0.5);
  });
});
