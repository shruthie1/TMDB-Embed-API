/* Shared site header, injected into a <div id="siteHeader"> on every page. */
(function () {
  function renderHeader(active) {
    const el = document.getElementById('siteHeader');
    if (!el) return;
    const link = (href, label, key) => `<a href="${href}"${active === key ? ' class="active"' : ''}>${label}</a>`;
    el.innerHTML = `
      <header class="site-header">
        <a class="brand" href="/home.html"><span>Chitram</span><span class="dot">•</span></a>
        <nav class="main-nav">
          ${link('/home.html', 'Home', 'home')}
          ${link('/search.html', 'Search', 'search')}
        </nav>
        <form class="header-search" id="headerSearchForm" role="search">
          <input id="headerSearchInput" type="search" placeholder="Search movies & series" aria-label="Search">
          <button type="submit" aria-label="Search">&#128269;</button>
        </form>
        <div class="header-actions">
          <button type="button" class="icon-btn" id="mobileSearchToggle" aria-label="Toggle search" title="Search">&#128269;</button>
          <button type="button" class="icon-btn" id="themeToggle" aria-label="Toggle theme" title="Toggle theme">&#9788;</button>
        </div>
      </header>`;

    const form = document.getElementById('headerSearchForm');
    const input = document.getElementById('headerSearchInput');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (q) location.href = `/search.html?q=${encodeURIComponent(q)}`;
    });
    const mobileToggle = document.getElementById('mobileSearchToggle');
    mobileToggle.addEventListener('click', () => {
      const wrap = document.querySelector('.header-search');
      wrap.classList.toggle('open');
      if (wrap.classList.contains('open')) input.focus();
    });

    const themeBtn = document.getElementById('themeToggle');
    function syncIcon() {
      const theme = document.documentElement.getAttribute('data-theme');
      const isLight = theme === 'light' || (!theme && window.matchMedia('(prefers-color-scheme: light)').matches);
      themeBtn.innerHTML = isLight ? '&#9789;' : '&#9788;';
    }
    syncIcon();
    themeBtn.addEventListener('click', () => { window.ChitramAPI.toggleTheme(); syncIcon(); });

    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    if (q && active === 'search') input.value = q;
  }

  window.renderHeader = renderHeader;
}());
