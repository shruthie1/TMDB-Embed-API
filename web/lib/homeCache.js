// In-tab cache for the home page payload.
//
// app/page.jsx is a client component that holds its rows in useState and fetches
// them in useEffect. The App Router unmounts it on every route change, so Back
// to home remounted with empty state and re-fetched every rail and the carousel
// (the user saw the carousel reload each return). A module-level object survives
// client route changes within one tab, so we stash the payload here and seed the
// page's state from it on mount. A preferences change clears it (the rows depend
// on the chosen languages), and it goes stale after a few minutes so a long-open
// tab still refreshes.

const TTL_MS = 5 * 60 * 1000;

let store = null; // { query, data, recs, rowErrors, at }

/** The cached payload for this prefs query, or null when absent/stale/mismatched. */
export function readHome(query) {
  if (!store || store.query !== query) return null;
  if (Date.now() - store.at > TTL_MS) { store = null; return null; }
  return store;
}

/** Replace the cached payload for this query. */
export function writeHome(query, { data, recs, rowErrors }) {
  store = { query, data, recs, rowErrors, at: Date.now() };
}

/** Merge a partial update into the cache for this query (keeps it warm as rows arrive). */
export function patchHome(query, patch) {
  if (!store || store.query !== query) {
    store = { query, data: {}, recs: [], rowErrors: {}, at: Date.now() };
  }
  Object.assign(store, patch, { at: Date.now() });
}

/** Drop the cache (a prefs change invalidates every cached row). */
export function clearHome() { store = null; }
