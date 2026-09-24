/* Chitram OTT — search page: live search, movie/series filter, grid results. */
(function () {
  const { search, dedupe, cardHtml, skeletonCards, esc } = window.ChitramAPI;
  const form = document.getElementById('searchForm');
  const input = document.getElementById('searchInput');
  const grid = document.getElementById('resultsGrid');
  const heading = document.getElementById('resultsHeading');
  const stateBlock = document.getElementById('stateBlock');
  const chips = document.querySelectorAll('.filter-chip');

  let currentType = 'all';
  let requestSeq = 0;
  let debounceTimer = null;

  function setState(html) { stateBlock.innerHTML = html; }
  function clearState() { stateBlock.innerHTML = ''; }

  function emptyPromptState() {
    setState(`<div class="state-block">
      <div class="state-icon">&#128269;</div>
      <h3>Search Chitram</h3>
      <p>Type a movie or series title above to find something to watch.</p>
    </div>`);
  }

  function noResultsState(query) {
    setState(`<div class="state-block">
      <div class="state-icon">&#128561;</div>
      <h3>No results for "${esc(query)}"</h3>
      <p>Try a different spelling, or search without the year.</p>
    </div>`);
  }

  function errorState(message) {
    setState(`<div class="state-block">
      <div class="state-icon">&#9888;</div>
      <h3>Something went wrong</h3>
      <p>${esc(message || 'The search request failed.')}</p>
    </div>`);
  }

  function loadingSkeleton() {
    clearState();
    heading.hidden = true;
    grid.innerHTML = skeletonCards(12);
  }

  async function runSearch() {
    const query = input.value.trim();
    if (!query) { grid.innerHTML = ''; heading.hidden = true; emptyPromptState(); return; }
    const seq = ++requestSeq;
    loadingSkeleton();
    try {
      const data = await search(query, currentType);
      if (seq !== requestSeq) return; // stale response, a newer search superseded it
      const results = dedupe(data.results || []);
      grid.innerHTML = results.map(cardHtml).join('');
      heading.hidden = false;
      heading.textContent = `${results.length} result${results.length === 1 ? '' : 's'} for "${query}"`;
      if (!results.length) noResultsState(query);
      else clearState();
    } catch (e) {
      if (seq !== requestSeq) return;
      grid.innerHTML = '';
      heading.hidden = true;
      errorState(e.message);
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(debounceTimer); runSearch(); });
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 380);
  });
  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentType = chip.dataset.type;
      if (input.value.trim()) runSearch();
    });
  });

  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  if (q) { input.value = q; runSearch(); }
  else emptyPromptState();
}());
