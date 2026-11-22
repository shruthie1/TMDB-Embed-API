'use client';

/**
 * Playlist text kept with cached rows (P3, 2026-11-22).
 *
 * A second Play from kept rows uses the SAME signed urls, so the master and
 * the video and audio media playlists are the same text. Measured on the APK
 * (RRR second Play 4.7 s), ~2 s of it was these playlists. They are kept in
 * memory, keyed by url, for the stream cache's TTL (30 min) cut short by the
 * url's own expiry, and served to hls.js through a custom playlist loader.
 *
 * Only VOD text is kept: a master, or a media playlist with #EXT-X-ENDLIST.
 * A live playlist changes and must be fetched. A failed row clears all of it
 * (lib/backend.js forgetTitleStreams).
 */
import { cappedTtlMs } from '../urlExpiry';
import { STREAM_CACHE_TTL_MS } from '../streamCache';

export const PLAYLIST_CACHE_MAX = 200;
const store = new Map(); // url -> { until, text, finalUrl }

function log(line) { try { console.info(line); } catch { /* never breaks play */ } }
function hostOf(u) { try { return new URL(u).hostname; } catch { return '?'; } }

export function isVodPlaylist(text) {
  const t = String(text || '');
  if (!t.startsWith('#EXTM3U')) return false;
  if (/#EXT-X-STREAM-INF/.test(t)) return true;               // master
  return /#EXTINF/.test(t) && /#EXT-X-ENDLIST/.test(t);       // VOD media
}

export function getPlaylist(url, now = Date.now()) {
  const e = store.get(url);
  if (!e) return null;
  if (!(now < e.until)) { store.delete(url); return null; }
  return e;
}

export function putPlaylist(url, text, finalUrl = url, now = Date.now()) {
  if (!url || !isVodPlaylist(text)) return false;
  const ttl = cappedTtlMs(STREAM_CACHE_TTL_MS, [{ url }, { url: finalUrl }], undefined, now);
  if (!(ttl > 0)) return false;
  store.delete(url);
  store.set(url, { until: now + ttl, text: String(text), finalUrl: finalUrl || url });
  while (store.size > PLAYLIST_CACHE_MAX) store.delete(store.keys().next().value);
  return true;
}

export function clearPlaylists() { store.clear(); }
export function playlistCacheSize() { return store.size; }

/**
 * hls.js playlist loader (pLoader) that answers from the cache and fills it.
 * On a hit no request leaves the browser; hls.js gets the same text and the
 * same final url (relative segment urls resolve against it).
 */
export function cachedPlaylistLoader(Base) {
  return class CachedPlaylistLoader extends Base {
    abort() {
      if (this.hitTimer) { clearTimeout(this.hitTimer); this.hitTimer = null; this.context = null; return; }
      super.abort();
    }
    destroy() {
      if (this.hitTimer) { clearTimeout(this.hitTimer); this.hitTimer = null; }
      super.destroy();
    }
    load(context, config, callbacks) {
      const url = context?.url;
      const hit = url ? getPlaylist(url) : null;
      if (hit) {
        log(`[cache] hit playlist:${context.type || '?'} ${hostOf(url)}`);
        this.context = context;
        const s = this.stats;
        const t = (globalThis.performance?.now?.() ?? Date.now());
        if (s) {
          s.loaded = s.total = hit.text.length;
          if (s.loading) { s.loading.start = s.loading.first = s.loading.end = t; }
        }
        // Async, like a real response: hls.js does not expect a callback
        // inside load().
        this.hitTimer = setTimeout(() => {
          this.hitTimer = null;
          if (this.context !== context) return; // destroyed meanwhile
          callbacks.onSuccess({ url: hit.finalUrl, data: hit.text }, s, context, null);
        }, 0);
        return;
      }
      super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, details) => {
          try {
            if (typeof response?.data === 'string') putPlaylist(url, response.data, response.url || url);
          } catch { /* keep playing uncached */ }
          callbacks.onSuccess(response, stats, ctx, details);
        },
      });
    }
  };
}
