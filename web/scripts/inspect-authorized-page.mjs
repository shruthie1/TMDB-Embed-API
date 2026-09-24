#!/usr/bin/env node

// Local-only helper for pages you own or are authorized to inspect.
// It intentionally does not accept, send, store, or print cookies.

const pageUrl = process.argv[2];
if (!pageUrl) {
  console.error('Usage: node scripts/inspect-authorized-page.mjs https://your-authorized-page.example/player');
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(pageUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
} catch (error) {
  console.error(`Invalid URL: ${error.message}`);
  process.exit(1);
}

const response = await fetch(parsed, {
  headers: {
    accept: 'text/html,application/xhtml+xml',
    'user-agent': 'Chitram-authorized-lab/1.0',
  },
  redirect: 'follow',
});
const html = await response.text();
const found = new Set();

for (const match of html.matchAll(/(?:src|href|file|source)\s*[:=]\s*["']([^"']+)["']/gi)) {
  const value = match[1].replaceAll('\\/', '/');
  if (/\.m3u8(?:$|[?#])/i.test(value)) {
    try { found.add(new URL(value, response.url).href); } catch { /* ignore malformed references */ }
  }
}

for (const match of html.matchAll(/https?:[^\s"'<>\\]+/gi)) {
  const value = match[0].replaceAll('\\/', '/');
  if (/\.m3u8(?:$|[?#])/i.test(value)) found.add(value);
}

console.log(`HTTP ${response.status} ${response.url}`);
if (!found.size) {
  console.log('No openly published HLS manifest found.');
  process.exit(response.ok ? 0 : 2);
}
console.log('HLS candidates:');
for (const url of found) console.log(`- ${url}`);
