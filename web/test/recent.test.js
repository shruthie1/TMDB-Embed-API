import { describe, it, expect, beforeEach } from 'vitest';
import { addRecent, getRecent, removeRecent, clearRecent } from '../lib/recent';

// localStorage stand-in: the module is local-only by design.
let store;
beforeEach(() => {
  store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
});
const KEY = 'chitram:recent:v1';

describe('recent searches survive a corrupt store', () => {
  it('discards a value that parses but is not an array', () => {
    // THE BUG: read() guarded only a JSON parse error. `{"a":1}` parses fine,
    // so the spread in addRecent threw "read.filter is not a function" - an
    // uncaught crash in the search box. Worse, it was unrecoverable: every
    // subsequent addRecent died before it could write a good value.
    store.set(KEY, '{"a":1}');
    expect(() => addRecent('Kantara')).not.toThrow();
    expect(getRecent()).toEqual(['Kantara']);
  });

  it('discards a bare string or number payload', () => {
    for (const junk of ['"hello"', '42', 'null', 'true']) {
      store.set(KEY, junk);
      expect(() => addRecent('RRR'), junk).not.toThrow();
      expect(getRecent(), junk).toEqual(['RRR']);
    }
  });

  it('drops non-string entries inside an otherwise valid array', () => {
    // x.toLowerCase() would throw on any of these.
    store.set(KEY, JSON.stringify(['ok', 42, null, { a: 1 }, 'fine']));
    expect(() => addRecent('New')).not.toThrow();
    expect(getRecent()).toEqual(['New', 'ok', 'fine']);
  });

  it('still recovers from unparseable json', () => {
    store.set(KEY, '{not json');
    expect(getRecent()).toEqual([]);
  });
});

describe('recent searches behave', () => {
  it('dedupes case-insensitively, keeping the newest spelling', () => {
    addRecent('Kantara');
    addRecent('kantara');
    expect(getRecent()).toEqual(['kantara']);
  });

  it('ignores a query shorter than two characters after trimming', () => {
    addRecent(' a ');
    addRecent('  Sita Ramam  ');
    expect(getRecent()).toEqual(['Sita Ramam']);
  });

  it('caps the list and keeps the newest', () => {
    for (let i = 0; i < 12; i++) addRecent(`query${i}`);
    const r = getRecent();
    expect(r).toHaveLength(8);
    expect(r[0]).toBe('query11');
    expect(r).not.toContain('query0');
  });

  it('removes by exact match only, so case differs deliberately', () => {
    // addRecent dedupes case-insensitively but removeRecent does not. Pinned
    // because it is a real asymmetry: the UI removes an entry it displayed
    // verbatim, so exact match is what it wants.
    addRecent('RRR');
    removeRecent('rrr');
    expect(getRecent()).toEqual(['RRR']);
    removeRecent('RRR');
    expect(getRecent()).toEqual([]);
  });

  it('clears everything', () => {
    addRecent('one'); addRecent('two');
    clearRecent();
    expect(getRecent()).toEqual([]);
  });
});
