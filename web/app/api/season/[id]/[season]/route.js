import { seasonEpisodes } from '../../../../../lib/catalog';

export const revalidate = 604800;

export async function GET(_req, { params }) {
  const episodes = await seasonEpisodes(params.id, params.season);
  return Response.json({ season: Number(params.season), episodes });
}
