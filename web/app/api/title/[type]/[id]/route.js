import { getTitle } from '../../../../../lib/catalog';
import { cachedJson, errorJson } from '../../../../../lib/edgeCache';

export const revalidate = 604800; // 7d — title metadata is stable (data cache only; edge cache: lib/edgeCache.js)

export async function GET(_req, { params }) {
  const { type, id } = params;
  if (type !== 'movie' && type !== 'tv') {
    return errorJson({ error: 'bad media type' }, 400);
  }
  const t = await getTitle(type, id);
  return t ? cachedJson(t) : errorJson({ error: 'not found' }, 404);
}
