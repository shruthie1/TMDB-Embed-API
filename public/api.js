/* Chitram OTT — shared API + small DOM helpers used by home/search/watch pages. */
(function (global) {
  const API_BASE = '';

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  }

  async function apiGet(path) {
    const res = await fetch(API_BASE + path);
    let data;
    try { data = await res.json(); } catch (_) { throw new Error(`Bad response (${res.status})`); }
    if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function search(query, type) {
    const t = type && type !== 'all' ? type : '';
    return apiGet(`/api/search?q=${encodeURIComponent(query)}${t ? `&type=${encodeURIComponent(t)}` : ''}`);
  }

  function streams(type, id) {
    return apiGet(`/api/streams/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
  }

  function providers() {
    return apiGet('/api/providers');
  }

  /**
   * There is no trending/popular endpoint on the backend yet. This function
   * is the single seam to swap in a real one later (e.g. GET /api/trending) —
   * every caller in this app goes through here rather than calling /api/search
   * directly for "discovery" rows, so only this function needs to change.
   */
  async function discover(seedQuery, type) {
    try {
      const data = await search(seedQuery, type);
      return Array.isArray(data.results) ? data.results : [];
    } catch (e) {
      console.warn('[discover] failed for seed', seedQuery, e);
      return [];
    }
  }

  /** Dedupe a list of TMDB result rows by id+mediaType, preserving order. */
  function dedupe(rows) {
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (!r || r.id == null) continue;
      const key = `${r.mediaType || 'movie'}:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  function posterUrl(item) { return item && item.poster ? item.poster : null; }
  function backdropUrl(item) { return item && (item.backdrop || item.poster) ? (item.backdrop || item.poster) : null; }

  function mediaLabel(type) { return type === 'series' ? 'Series' : 'Movie'; }

  function watchHref(item) {
    const type = item.mediaType === 'series' ? 'series' : 'movie';
    return `/watch.html?type=${encodeURIComponent(type)}&id=${encodeURIComponent(item.id)}&title=${encodeURIComponent(item.title || '')}`;
  }

  // ---- Theme handling shared across pages ----
  const THEME_KEY = 'chitram-theme';
  function getStoredTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (_) { return null; }
  }
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }
  function initTheme() {
    applyTheme(getStoredTheme());
  }
  function toggleTheme() {
    const current = getStoredTheme() || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyTheme(next);
    return next;
  }

  function showToast(message, kind) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = message;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function cardHtml(item) {
    const poster = posterUrl(item);
    const rating = item.rating && Number(item.rating) > 0 ? Number(item.rating).toFixed(1) : null;
    return `<a class="card" href="${esc(watchHref(item))}" data-id="${esc(item.id)}" data-type="${esc(item.mediaType)}" data-title="${esc(item.title)}">
      <div class="card-poster">
        ${poster ? `<img src="${esc(poster)}" alt="${esc(item.title)}" loading="lazy">` : `<div class="no-poster">${esc(item.title || 'No artwork')}</div>`}
        ${rating ? `<span class="card-rating">★ ${esc(rating)}</span>` : ''}
      </div>
      <div class="card-body">
        <p class="card-title">${esc(item.title)}</p>
        <p class="card-meta">${esc(mediaLabel(item.mediaType))}${item.year ? ` · ${esc(item.year)}` : ''}</p>
      </div>
    </a>`;
  }

  function skeletonCards(n) {
    return Array.from({ length: n }).map(() => `<div class="card skel-card">
      <div class="skel skel-poster"></div>
      <div class="skel skel-line" style="width:85%"></div>
      <div class="skel skel-line" style="width:55%"></div>
    </div>`).join('');
  }

  global.ChitramAPI = {
    esc, apiGet, search, streams, providers, discover, dedupe,
    posterUrl, backdropUrl, mediaLabel, watchHref,
    initTheme, toggleTheme, applyTheme,
    showToast, cardHtml, skeletonCards,
  };
}(window));
