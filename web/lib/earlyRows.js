import { PREF_LANGS, prefsQuery, cleanLangs } from './prefs';

/**
 * Home's first rows, requested by an inline script while the HTML parses.
 *
 * Home is a client page: its rows used to be requested only after React had
 * hydrated, which on a phone (Slow 4G, 4x CPU) is about 2.2s after the
 * request. The hero art waits on the Top 10 row, so its image started even
 * later. Started from the HTML these answers are in hand by hydration.
 *
 * The script builds the SAME url fetchRow builds (prefsQuery of the stored,
 * cleaned languages) and leaves a promise per url; getJson (lib/api.js)
 * takes it once. Any mismatch just means a normal fetch.
 *
 * When Top 10 lands, the script also starts the hero's first backdrop (the
 * home LCP) at high priority. On a phone the row posters (w500, ~80kB each)
 * otherwise share the link with it from the same moment, and its download
 * took 3.5-5s on Slow 4G. Starting it before hydration gives it a head start.
 * The url is heroBackdrop()'s, so the CSS background reuses the response.
 */
// lib/api.js IMG; not imported, as api.js imports this file.
const TMDB_IMG = 'https://image.tmdb.org/t/p';

export const EARLY_ROW_KINDS = ['top10', 'recent', 'trending'];

export const EARLY_ROWS_SCRIPT = `(function(){try{
var codes=${JSON.stringify(PREF_LANGS.map(l => l.code))},l=[];
try{var p=JSON.parse(localStorage.getItem('chitram:prefs:v1')||'null');
(p&&p.langs||[]).forEach(function(c){c=String(c).trim().toLowerCase();if(codes.indexOf(c)>=0&&l.indexOf(c)<0)l.push(c);});}catch(e){}
var q=l.length?'?'+new URLSearchParams({langs:l.join(',')}).toString():'';
var e=window.__chitramEarly=window.__chitramEarly||{};
${JSON.stringify(EARLY_ROW_KINDS)}.forEach(function(k){var u='/api/rows/'+k+q;
e[u]=fetch(u).then(function(r){return r.json().then(function(b){
if(k==='top10'&&r.ok)art(b);return{ok:r.ok,status:r.status,body:b};});}).catch(function(){return null;});});
function art(b){try{var t=(b.titles||[]).filter(function(x){return x&&x.backdrop;})[0];if(!t)return;
var n=window.matchMedia&&matchMedia('(max-width:719px)').matches,p=t.backdrop;
var i=new Image();i.fetchPriority='high';i.src=p.indexOf('http')===0?p:'${TMDB_IMG}/'+(n?'w1280':'original')+p;}catch(x){}}
}catch(e){}})();`;

/**
 * The title page's full record, requested by an inline script while the HTML
 * parses (same idea as the rows). Its backdrop is the page's LCP, so the
 * script starts that image at high priority as soon as the record lands:
 * before this the backdrop request waited for hydration and then shared the
 * link with the poster, logo, cast photos and the player chunks (LCP 5.2s on
 * Slow 4G). It also means the fast record never paints first on a hard load,
 * so its Cinemeta backdrop and poster are no longer downloaded and dropped.
 */
export const EARLY_TITLE_SCRIPT = `(function(){try{
var m=location.pathname.match(/^\\/title\\/(movie|tv)\\/(\\d+)\\/?$/);if(!m)return;
var u='/api/title/'+m[1]+'/'+m[2]+'/full',e=window.__chitramEarly=window.__chitramEarly||{};
e[u]=fetch(u).then(function(r){return r.json().then(function(b){
if(r.ok&&b&&b.backdrop){var n=window.matchMedia&&matchMedia('(max-width:719px)').matches,p=b.backdrop;
var i=new Image();i.fetchPriority='high';i.src=p.indexOf('http')===0?p:'${TMDB_IMG}/'+(n?'w1280':'original')+p;}
return{ok:r.ok,status:r.status,body:b};});}).catch(function(){return null;});
}catch(e){}})();`;

/** The url the script requests for one row; kept in step by the tests. */
export function earlyRowUrl(kind, langs) {
  const q = prefsQuery({ langs: cleanLangs(langs) });
  return `/api/rows/${kind}${q ? `?${q}` : ''}`;
}

/** The early answer for this url, once; null when there is none. */
export function takeEarly(url) {
  if (typeof window === 'undefined') return null;
  const early = window.__chitramEarly;
  if (!early || !early[url]) return null;
  const p = early[url];
  delete early[url];
  return p;
}
