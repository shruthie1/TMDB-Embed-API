/**
 * Vercel edge cache for the catalog routes.
 *
 * `export const revalidate` does NOT cache these routes. A route handler under
 * a dynamic segment ([type]/[id]) with no generateStaticParams builds as
 * "ƒ (Dynamic)" (next build, 2026-11-21), so Next sends
 * `cache-control: public, max-age=0, must-revalidate` and Vercel answers every
 * hit from the function (x-vercel-cache: MISS twice in a row, iad1). An
 * explicit s-maxage is what the edge honours: /api/rows already sends one and
 * its second hit was x-vercel-cache: HIT (same check, same minute).
 *
 * Partial answers (an upstream timeout) get a short life so a TMDB hiccup is
 * not pinned for a week; errors are never cached.
 */
export const WEEK_S = 604800;
export const SHORT_S = 300;

export function cachedJson(body, sMaxAge = WEEK_S) {
  const swr = Math.min(sMaxAge, 86400);
  return Response.json(body, {
    headers: { 'Cache-Control': `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}` },
  });
}

export function errorJson(body, status) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
