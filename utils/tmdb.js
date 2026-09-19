const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const { getTmdbApiKey } = require('./tmdbKey');

const cache = {
  imdbByTmdb: new Map(),
  details: new Map(),
  searches: new Map(),
};
const TTL_MS = 6 * 60 * 60 * 1000;
function isFresh(entry) { return entry && (Date.now() - entry.ts) < TTL_MS; }

async function tmdbFetchJson(url) {
  const apiKey = getTmdbApiKey();
  if (!apiKey) throw new Error('TMDB_API_KEY missing');
  const sep = url.includes('?') ? '&' : '?';
  const full = `${url}${sep}api_key=${apiKey}`;
  const res = await fetch(full, { timeout: 15000 });
  if (!res.ok) throw new Error(`TMDB request failed ${res.status}`);
  return res.json();
}
async function getExternalIds(type, tmdbId) {
  const key = `${type}:${tmdbId}`;
  const cached = cache.imdbByTmdb.get(key);
  if (isFresh(cached)) return cached.data;
  const json = await tmdbFetchJson(`https://api.tmdb.org/3/${type}/${tmdbId}/external_ids`);
  cache.imdbByTmdb.set(key, { data: json, ts: Date.now() });
  return json;
}
async function getDetails(type, tmdbId) {
  const key = `${type}:${tmdbId}:details`;
  const cached = cache.details.get(key);
  if (isFresh(cached)) return cached.data;
  const json = await tmdbFetchJson(`https://api.tmdb.org/3/${type}/${tmdbId}`);
  cache.details.set(key, { data: json, ts: Date.now() });
  return json;
}
async function searchTitles(query, mediaType = 'all') {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const kind = mediaType === 'series' ? 'tv' : mediaType === 'movie' ? 'movie' : 'all';
  const cacheKey = `${kind}:${q.toLowerCase()}`;
  const cached = cache.searches.get(cacheKey);
  if (isFresh(cached)) return cached.data;
  const json = await tmdbFetchJson(`https://api.tmdb.org/3/search/multi?query=${encodeURIComponent(q)}&include_adult=false&language=en-US&page=1`);
  const results = (Array.isArray(json.results) ? json.results : [])
    .filter(item => (kind === 'all' ? ['movie', 'tv'].includes(item.media_type) : item.media_type === kind))
    .slice(0, 20)
    .map(item => ({
      id: item.id,
      mediaType: item.media_type === 'tv' ? 'series' : 'movie',
      title: item.title || item.name || 'Untitled',
      overview: item.overview || '',
      year: String(item.release_date || item.first_air_date || '').slice(0, 4),
      rating: Number(item.vote_average || 0).toFixed(1),
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : null,
      backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null,
    }));
  cache.searches.set(cacheKey, { data: results, ts: Date.now() });
  return results;
}
async function resolveImdbId(type, tmdbId) {
  try { const ext = await getExternalIds(type, tmdbId); return ext.imdb_id || null; } catch { return null; }
}
module.exports = { getExternalIds, getDetails, searchTitles, resolveImdbId };
