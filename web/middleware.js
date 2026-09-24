import { NextResponse } from 'next/server';

/**
 * Gate the operator surfaces. Nothing here touches playback.
 *
 * /stats and /providers are unlinked from the app but were reachable by anyone
 * with the url, and /providers MUTATES: its test route runs a real extraction
 * behind Chromium. Measured against production before this existed - an
 * anonymous POST to /api/vm/api/providers/mapple/test returned 200 after 48.1
 * SECONDS, having spent that long extracting on the VM that also hosts a live
 * revenue fleet. That is the exposure, not the page being readable.
 *
 * A shared secret in a cookie, deliberately: this guards a household's
 * operator pages, not user accounts. Real auth is a separate decision (see
 * docs/auth-design.md) and should not hold up closing an open door.
 *
 * Media routes are NOT gated. hls.js fetches /api/seg and /api/m3u8 directly,
 * and `?direct=1` hands raw CDN urls to native clients outside any check we
 * add - so gating them here would break playback without actually closing that
 * path. Pages are what this protects.
 */


// GET /api/providers is a plain read the operator page needs before it can
// show anything. Everything that CHANGES state - add, delete, enable, test -
// is a write, and that is what needs the key.
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isProtected(pathname, method) {
  if (/^\/(stats|providers)(\/|$)/.test(pathname)) return true;   // pages, always
  if (/^\/api\/providers(\/|$)/.test(pathname)) return !READ_ONLY_METHODS.has(method);
  return false;
}

const COOKIE = 'chitram_op';

export function middleware(req) {
  const { pathname } = req.nextUrl;
  if (!isProtected(pathname, req.method)) return NextResponse.next();

  const secret = process.env.OPERATOR_SECRET;
  // Unset means unconfigured, not "allow everyone". Failing OPEN here is how
  // the door was left open in the first place; a 503 is loud and safe.
  if (!secret) {
    return new NextResponse('operator access is not configured', {
      status: 503, headers: { 'cache-control': 'no-store' },
    });
  }

  // Either the cookie is already set, or a one-time ?key= sets it. The query
  // form is what makes this usable from a TV browser with no keyboard.
  const supplied = req.cookies.get(COOKIE)?.value ?? req.nextUrl.searchParams.get('key');
  if (supplied === secret) {
    const res = NextResponse.next();
    if (!req.cookies.get(COOKIE)) {
      res.cookies.set(COOKIE, secret, {
        httpOnly: true, sameSite: 'lax', secure: true, path: '/',
        maxAge: 60 * 60 * 24 * 90,
      });
    }
    return res;
  }

  // 404, not 401: an operator page nobody is meant to find should look like it
  // does not exist rather than advertise that a key would open it.
  return new NextResponse('Not found', {
    status: 404, headers: { 'cache-control': 'no-store' },
  });
}

export const config = {
  // Narrow, so playback never passes through this at all.
  matcher: [
    '/stats/:path*',
    '/providers/:path*',
    // Was '/api/vm/api/providers/*' until the VM relay was deleted
    // (2026-09-22). The operator mutations now go straight to the Express
    // backend through the next.config rewrite, so the gate has to sit on the
    // path the browser actually calls or these become anonymous again.
    '/api/providers/:path*',
  ],
};
