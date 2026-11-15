export const dynamic = 'force-dynamic';

function text(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function capture(html, pattern) {
  return html.match(pattern)?.[1]?.trim() || null;
}

function metadata(html, pageUrl) {
  const title = text(capture(html, /<h2[^>]+class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)
    || capture(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const description = capture(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  const language = text(capture(html, /<strong>\s*Language:\s*<\/strong>\s*(?:<a[^>]*>)?([\s\S]*?)(?:<\/a>)?<\/p>/i));
  const image = capture(html, /<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i);
  const locBlock = capture(html, /locations\s*=\s*(\[[\s\S]*?\]);/i);
  let providers = [];
  try {
    providers = JSON.parse(locBlock?.replaceAll('\\/', '/') || '[]')
      .map(url => new URL(String(url), pageUrl).hostname);
  } catch { /* malformed provider array is reported as empty */ }
  const evidence = [];
  if (/telugu/i.test(`${title} ${description || ''}`)) evidence.push('page text');
  if (/^telugu$/i.test(language)) evidence.push('language field');
  if (/telugu/i.test(image || '')) evidence.push('poster');
  return {
    title: title || null,
    language: language || (evidence.length ? 'Telugu' : null),
    languageEvidence: evidence,
    providerHosts: [...new Set(providers)],
    audioMode: 'unknown until an authorized HLS manifest is supplied',
  };
}

export async function GET(request) {
  const pageUrl = new URL(request.url).searchParams.get('url')?.trim();
  if (!pageUrl) return Response.json({ ok: false, error: 'url is required' }, { status: 400 });
  let parsed;
  try { parsed = new URL(pageUrl); } catch {
    return Response.json({ ok: false, error: 'invalid URL' }, { status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return Response.json({ ok: false, error: 'only HTTP(S) URLs are supported' }, { status: 400 });
  }
  try {
    const response = await fetch(parsed, {
      headers: { accept: 'text/html', 'user-agent': 'Chitram-local-lab/1.0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    const html = await response.text();
    return Response.json({ ok: response.ok, status: response.status,
      metadata: response.ok ? metadata(html, parsed.href) : null });
  } catch (error) {
    return Response.json({ ok: false, error: error.message.slice(0, 160) }, { status: 502 });
  }
}
