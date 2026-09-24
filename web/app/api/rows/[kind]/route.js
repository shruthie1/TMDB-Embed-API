import { discoverByLang, trendingIndia, trendingGlobal, trendingSeriesGlobal,
         recentlyAdded, discover, LANGS } from '../../../../lib/catalog';

export const revalidate = 21600; // 6h — discovery rows change slowly

export async function GET(_req, { params }) {
  const { kind } = params;
  let titles = [];
  if (kind === 'trending') titles = await trendingIndia();
  else if (kind === 'global') titles = await trendingGlobal();
  else if (kind === 'globalseries') titles = await trendingSeriesGlobal();
  else if (kind === 'recent') titles = await recentlyAdded();
  // Series in the household's languages as ONE row: per-language TV coverage
  // is too thin to stand alone (measured: Telugu 2, Kannada 1, Malayalam 1),
  // so five sparse rails would read as broken. Combined it returns ~210.
  else if (kind === 'series') {
    const r = await discover({ type: 'tv', langs: LANGS.map(l => l.code),
                               sort: 'popularity.desc' });
    titles = r.titles.slice(0, 18);
  }
  else if (LANGS.some(l => l.code === kind)) titles = await discoverByLang(kind);
  else return Response.json({ error: 'unknown row' }, { status: 404 });

  return Response.json({ kind, titles });
}
