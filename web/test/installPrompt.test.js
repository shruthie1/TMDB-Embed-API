import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../components/InstallPrompt.jsx', import.meta.url)), 'utf8');

describe('native PWA install banner', () => {
  it('does not intercept beforeinstallprompt', () => {
    expect(src).not.toMatch(/addEventListener\(['"]beforeinstallprompt/);
    expect(src).not.toMatch(/\.preventDefault\(\)/);
    expect(src).not.toMatch(/\.prompt\(\)/);
  });

  it('keeps the service worker registration independent from install UI', () => {
    expect(src).toMatch(/serviceWorker\.register\(['"]\/sw\.js['"]/);
    expect(src).toMatch(/return null/);
  });
});
