import { describe, it, expect } from 'vitest';
import { proxiedSegment, playableUrl } from '../lib/api';

/**
 * Every manifest and segment reaches the browser through these two builders,
 * and the url they wrap is a SIGNED cdn url: query string, ampersands, base64
 * padding, percent-escapes already present. One mis-encoded character and the
 * cdn rejects the signature - which surfaces as a 403 that looks like an
 * expired link rather than a bug on our side.
 */
// Deliberately nasty but realistic: `+` and `/` are base64, `==` is padding,
// `%2F` is an escape that must not be double-encoded.
const SIGNED = 'https://a2.shows.st/api?d=PeUjoxjc+jc/ERj==&t=1788411524&sig=abc%2Fdef';
const REFERER = 'https://player.vidlove.cc/';
// Any origin: the builders emit relative paths, and URL needs a base to parse.
const ORIGIN = 'https://chtrm.vercel.app';

describe.each([
  ['playableUrl', playableUrl, '/api/m3u8'],
  ['proxiedSegment', proxiedSegment, '/api/seg'],
])('%s', (_name, build, path) => {
  it('builds a SAME-ORIGIN url that never names the VM', () => {
    // The browser must not learn the resolver's address: it sits behind an
    // ephemeral tunnel, and a plain-http VM is unreachable from an https page.
    // A relative path is what makes the request go to Vercel, which adds the
    // real origin server-side.
    const out = build(SIGNED, REFERER);
    expect(out.startsWith(`${path}?`)).toBe(true);
    expect(out).not.toMatch(/^https?:\/\//);
    expect(out).not.toContain('trycloudflare');
    expect(out).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('round-trips a signed url byte for byte', () => {
    // The whole contract. A `+` decoded as a space, or a double-encoded %2F,
    // breaks the signature and the cdn 403s.
    const got = new URL(build(SIGNED, REFERER), ORIGIN).searchParams.get('u');
    expect(got).toBe(SIGNED);
  });

  it('encodes characters that would otherwise split the query', () => {
    const out = build(SIGNED, REFERER);
    expect(out).not.toContain('d=PeUjoxjc+jc');   // raw + would decode to a space
    expect(out).not.toContain('&t=1788411524&sig');  // raw & would end the u param
  });

  it('carries the referer, which the cdn requires', () => {
    expect(new URL(build(SIGNED, REFERER), ORIGIN).searchParams.get('r')).toBe(REFERER);
  });

  it('keeps nested media on the referer-aware segment relay', () => {
    expect(new URL(playableUrl(SIGNED), ORIGIN).searchParams.has('direct')).toBe(false);
  });

  it('omits the referer entirely when there is none', () => {
    // Absent, not empty: an empty Referer header is not the same as no header,
    // and some cdns reject it.
    expect(new URL(build(SIGNED), ORIGIN).searchParams.has('r')).toBe(false);
    expect(new URL(build(SIGNED, null), ORIGIN).searchParams.has('r')).toBe(false);
  });
});
