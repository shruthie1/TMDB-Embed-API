import { getTitleFull } from '../../../../../../lib/catalog';
import { cachedJson, errorJson, WEEK_S, SHORT_S } from '../../../../../../lib/edgeCache';

export const revalidate = 604800;

export async function GET(_req, { params }) {
  const { type, id } = params;
  if (type !== 'movie' && type !== 'tv') {
    return errorJson({ error: 'bad media type' }, 400);
  }
  const t = await getTitleFull(type, id);
  if (!t) return errorJson({ error: 'not found' }, 404);
  // Not enriched = TMDB timed out and this is the fast record only: keep it briefly.
  return cachedJson(t, t.enriched ? WEEK_S : SHORT_S);
}
