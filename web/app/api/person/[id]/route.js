import { personCredits, personInfo } from '../../../../lib/catalog';
import { cachedJson, errorJson } from '../../../../lib/edgeCache';

export const revalidate = 604800; // a filmography changes rarely

export async function GET(_req, { params }) {
  const [person, credits] = await Promise.all([
    personInfo(params.id),
    personCredits(params.id),
  ]);
  if (!person) return errorJson({ error: 'not found' }, 404);
  return cachedJson({ person, titles: credits.titles });
}
