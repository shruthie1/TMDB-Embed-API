/* Chitram OTT — home page: hero + carousels sourced from /api/search seeds.
 * There is no trending/popular endpoint yet. Each row below is defined by a
 * "seed query" plus a media-type filter, and fetched through
 * ChitramAPI.discover(). Swap discover()'s implementation (in api.js) for a
 * real GET /api/trending or /api/popular call later and every row here picks
 * it up with no further changes — as long as the response keeps the same
 * {id, mediaType, title, overview, poster, backdrop, year, rating} shape.
 */
(function () {
  const { esc, discover, dedupe, cardHtml, skeletonCards, watchHref, showToast } = window.ChitramAPI;

  const ROWS = [
    { title: 'Trending Now', seed: 'avengers', type: 'movie' },
    { title: 'Popular Movies', seed: 'action', type: 'movie' },
    { title: 'Popular Series', seed: 'the', type: 'series' },
    { title: 'Top Rated', seed: 'godfather', type: 'movie' },
    { title: 'Regional Picks', seed: 'kantara', type: 'movie' },
  ];

  const heroSection = document.getElementById('heroSection');
  const rowsEl = document.getElementById('rows');

  function renderHeroSkeleton() {
    heroSection.innerHTML = `<div class="hero skel skel-hero"></div>`;
  }

  function renderHero(item) {
    if (!item) { heroSection.innerHTML = ''; return; }
    const backdrop = item.backdrop || item.poster;
    heroSection.innerHTML = `
      <div class="hero">
        <div class="hero-media">${backdrop ? `<img src="${esc(backdrop)}" alt="">` : ''}</div>
        <div class="hero-scrim"></div>
        <div class="hero-content">
          <p class="hero-eyebrow">Featured</p>
          <h1 class="hero-title">${esc(item.title)}</h1>
          <div class="hero-meta">
            <span class="badge">${esc(item.mediaType === 'series' ? 'Series' : 'Movie')}</span>
            ${item.year ? `<span class="badge">${esc(item.year)}</span>` : ''}
            ${item.rating && Number(item.rating) > 0 ? `<span class="badge rating">★ ${esc(Number(item.rating).toFixed(1))}</span>` : ''}
          </div>
          <p class="hero-overview">${esc(item.overview || '')}</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="${esc(watchHref(item))}">&#9658; Play</a>
            <a class="btn" href="/search.html?q=${esc(encodeURIComponent(item.title))}">More like this</a>
          </div>
        </div>
      </div>`;
  }

  function renderRowSkeleton(title) {
    const id = 'row-' + title.replace(/\W+/g, '-');
    const section = document.createElement('section');
    section.className = 'row';
    section.id = id;
    section.innerHTML = `
      <div class="row-head"><h2>${esc(title)}</h2></div>
      <div class="row-scroll">${skeletonCards(6)}</div>`;
    rowsEl.appendChild(section);
    return section;
  }

  function renderRow(section, title, items) {
    if (!items.length) {
      section.innerHTML = `
        <div class="row-head"><h2>${esc(title)}</h2></div>
        <div class="state-block" style="padding:24px 40px;align-items:flex-start;text-align:left;">
          <p>Couldn't load this row right now.</p>
        </div>`;
      return;
    }
    const scrollId = section.id + '-scroll';
    section.innerHTML = `
      <div class="row-head">
        <h2>${esc(title)}</h2>
        <div class="row-nav">
          <button class="icon-btn" data-dir="-1" data-target="${scrollId}" aria-label="Scroll left">&#8249;</button>
          <button class="icon-btn" data-dir="1" data-target="${scrollId}" aria-label="Scroll right">&#8250;</button>
        </div>
      </div>
      <div class="row-scroll" id="${scrollId}" tabindex="0">${items.map(cardHtml).join('')}</div>`;
  }

  rowsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-dir]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.target);
    if (target) target.scrollBy({ left: Number(btn.dataset.dir) * 640, behavior: 'smooth' });
  });

  // Keyboard scroll for each row when focused
  rowsEl.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('row-scroll')) return;
    if (e.key === 'ArrowRight') { e.target.scrollBy({ left: 320, behavior: 'smooth' }); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { e.target.scrollBy({ left: -320, behavior: 'smooth' }); e.preventDefault(); }
  });

  async function init() {
    renderHeroSkeleton();
    const sections = ROWS.map(r => renderRowSkeleton(r.title));

    const results = await Promise.all(ROWS.map(r => discover(r.seed, r.type)));

    const allForHero = dedupe(results.flat()).filter(i => i.poster);
    renderHero(allForHero[0] || dedupe(results.flat())[0]);
    if (!allForHero.length) showToast('Could not load featured title.', 'error');

    ROWS.forEach((r, i) => renderRow(sections[i], r.title, dedupe(results[i])));
  }

  init().catch((e) => {
    console.error(e);
    showToast('Failed to load home page content.', 'error');
  });
}());
