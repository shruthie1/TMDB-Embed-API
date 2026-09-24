import { describe, it, expect, beforeEach } from 'vitest';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const api = await import('../lib/lastProvider');

beforeEach(() => store.clear());

describe('last provider preference', () => {
  it('isolates movies and TV episodes', () => {
    api.rememberProvider('movie', 10, 'showsst');
    api.rememberProvider('tv', 10, 'vidking', 1, 1);
    api.rememberProvider('tv', 10, 'vidzee', 1, 2);
    expect(api.getLastProvider('movie', 10)).toBe('showsst');
    expect(api.getLastProvider('tv', 10, 1, 1)).toBe('vidking');
    expect(api.getLastProvider('tv', 10, 1, 2)).toBe('vidzee');
  });

  it('does not remove a newer provider when an older one fails', () => {
    api.rememberProvider('movie', 10, 'vidking');
    api.rememberProvider('movie', 10, 'showsst');
    api.forgetProvider('movie', 10, 'vidking');
    expect(api.getLastProvider('movie', 10)).toBe('showsst');
  });

  it('removes the failed provider preference', () => {
    api.rememberProvider('movie', 10, 'vidking');
    api.forgetProvider('movie', 10, 'vidking');
    expect(api.getLastProvider('movie', 10)).toBeNull();
  });
});
