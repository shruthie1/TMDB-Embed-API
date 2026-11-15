/**
 * VaPlayer as an EMBED: their own page in an iframe, last in the Servers list.
 *
 * Resolving VaPlayer on the server stopped working: its chain needs a forged
 * Referer/Origin and single-use, IP-bound tokens (providers/vaplayer.js), and
 * the server IP gets a captcha. Measured 2026-11-16: va_src.php answers 403
 * {"error":"unavailable"} from here, while the public page
 * vaplayer.ru/embed/movie/<imdb> answers 200. In an iframe the viewer's own
 * browser runs that chain, from the viewer's own IP.
 *
 * The trade is the usual one for an embed: their player owns seeking,
 * quality, audio and subtitles, and our watch position is not recorded. So it
 * is manual, except when nothing of ours can play at all.
 */
export const VA_EMBED_ID = 'vaplayer-embed';
export const VA_EMBED_LABEL = 'VaPlayer (embed)';
const ORIGIN = 'https://vaplayer.ru';

/** The public embed page, or null when the title has no usable imdb id. */
export function vaEmbedUrl({ imdbId, mediaType, season = 0, episode = 0 } = {}) {
  const imdb = String(imdbId || '');
  if (!/^tt\d{6,}$/.test(imdb)) return null;
  if (mediaType === 'tv') {
    const s = Number(season), e = Number(episode);
    if (!(s > 0 && e > 0)) return null;
    return `${ORIGIN}/embed/tv/${imdb}/${s}/${e}`;
  }
  return `${ORIGIN}/embed/movie/${imdb}`;
}

/** The Servers-menu row for it, or null. Always appended LAST by callers. */
export function vaEmbedChoice(title = {}) {
  const url = vaEmbedUrl(title);
  return url ? { id: VA_EMBED_ID, label: VA_EMBED_LABEL, quality: null, embed: true, url } : null;
}

/**
 * Switch to the embed on our own ONLY when the resolve returned zero sources.
 *
 * It used to fire whenever every held source was "dead", and dead was keyed
 * by provider name, so one CastleTV failure on Devara (five CastleTV rows)
 * made all five dead and the embed replaced a title that still had four
 * untouched rows. Measured live on chtrm2 2026-11-16: the embed came on while
 * CastleTV was playing. With any source in hand the viewer chooses.
 */
export function shouldAutoEmbed({ embed, error, sources = [] }) {
  if (!embed || !error) return false;
  return !(sources || []).some((s) => s?.masterUrl);
}
