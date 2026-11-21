import { seasonEpisodes } from '../../../../../lib/catalog';
import { cachedJson, WEEK_S, SHORT_S } from '../../../../../lib/edgeCache';

export const revalidate = 604800;

export async function GET(_req, { params }) {
  const episodes = await seasonEpisodes(params.id, params.season);
  return cachedJson({ season: Number(params.season), episodes }, episodes.length ? WEEK_S : SHORT_S);
}
