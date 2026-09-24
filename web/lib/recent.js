'use client';
// Recent searches. Local-only, capped, and clearable — a convenience, never a
// record we keep on your behalf.
const KEY = 'chitram:recent:v1';
const MAX = 8;

// The shape matters as much as the parse. `{"a":1}` is valid JSON but not an
// array, and the spread in addRecent then throws TypeError: read.filter is not
// a function - an uncaught crash in the search box, from one bad localStorage
// value that nothing can clear because addRecent dies before it writes.
const read = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; }
};
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };

export const getRecent = () => read();

export function addRecent(q) {
  const t = q.trim();
  if (t.length < 2) return;
  const next = [t, ...read().filter(x => x.toLowerCase() !== t.toLowerCase())].slice(0, MAX);
  write(next);
}

export const removeRecent = (q) => write(read().filter(x => x !== q));
export const clearRecent = () => write([]);
