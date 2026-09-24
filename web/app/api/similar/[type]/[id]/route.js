import { similarTitles } from '../../../../../lib/catalog';

export const revalidate = 604800;

export async function GET(_req, { params }) {
  const { type, id } = params;
  if (type !== 'movie' && type !== 'tv') {
    return Response.json({ error: 'bad media type' }, { status: 400 });
  }
  return Response.json({ titles: await similarTitles(type, id) });
}
