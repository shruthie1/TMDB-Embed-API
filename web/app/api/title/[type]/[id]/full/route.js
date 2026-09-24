import { getTitleFull } from '../../../../../../lib/catalog';

export const revalidate = 604800;

export async function GET(_req, { params }) {
  const { type, id } = params;
  if (type !== 'movie' && type !== 'tv') {
    return Response.json({ error: 'bad media type' }, { status: 400 });
  }
  const t = await getTitleFull(type, id);
  return t ? Response.json(t) : Response.json({ error: 'not found' }, { status: 404 });
}
