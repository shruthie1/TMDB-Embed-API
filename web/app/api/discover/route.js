import { discover } from '../../../lib/catalog';

export const revalidate = 21600;

const nums = (v) => (v || '').split(',').filter(Boolean).map(Number).filter(n => !Number.isNaN(n));
const strs = (v) => (v || '').split(',').filter(Boolean);

export async function GET(req) {
  const q = new URL(req.url).searchParams;
  const out = await discover({
    type: q.get('type') === 'tv' ? 'tv' : 'movie',
    langs: strs(q.get('lang')),
    genres: nums(q.get('genre')),
    yearFrom: q.get('from') ? Number(q.get('from')) : undefined,
    yearTo: q.get('to') ? Number(q.get('to')) : undefined,
    minRating: q.get('min') ? Number(q.get('min')) : undefined,
    sort: q.get('sort') || 'popularity.desc',
    page: Number(q.get('page') || 1),
  });
  return Response.json(out);
}
