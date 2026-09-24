import { personCredits, personInfo } from '../../../../lib/catalog';

export const revalidate = 604800; // a filmography changes rarely

export async function GET(_req, { params }) {
  const [person, credits] = await Promise.all([
    personInfo(params.id),
    personCredits(params.id),
  ]);
  if (!person) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ person, titles: credits.titles });
}
