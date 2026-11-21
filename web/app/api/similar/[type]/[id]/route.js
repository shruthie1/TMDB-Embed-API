import { similarTitles } from '../../../../../lib/catalog';
import { cachedJson, errorJson, WEEK_S, SHORT_S } from '../../../../../lib/edgeCache';

export const revalidate = 604800;

export async function GET(_req, { params }) {
  const { type, id } = params;
  if (type !== 'movie' && type !== 'tv') {
    return errorJson({ error: 'bad media type' }, 400);
  }
  const titles = await similarTitles(type, id);
  // Empty is usually a TMDB hiccup; do not pin it for a week.
  return cachedJson({ titles }, titles.length ? WEEK_S : SHORT_S);
}
