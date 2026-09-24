import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const overlays = readFileSync(
  fileURLToPath(new URL('../components/player/overlays.jsx', import.meta.url)), 'utf8');

/**
 * The embed fallback runs a PROVIDER'S OWN page in our tab.
 *
 * Their pages inject popunders at runtime - the same hosts the extractor
 * blocks - so the frame stays sandboxed. A provider that refuses to run that
 * way (mapple: "Sandbox Detected") is simply not embeddable; dropping the
 * sandbox to satisfy it would hand those scripts the viewer's tab.
 *
 * That is a deliberate trade, so it is pinned here rather than left to be
 * "fixed" by whoever next sees the error screen.
 */
describe('the embed iframe stays sandboxed', () => {
  it('carries a sandbox attribute at all', () => {
    expect(overlays).toMatch(/<iframe[^>]*className="embed-frame"/s);
    const iframe = overlays.match(/<iframe className="embed-frame"[\s\S]*?\/>/)[0];
    expect(iframe).toMatch(/sandbox=/);
  });

  it('never grants top-level navigation or popups', () => {
    // allow-top-navigation would let their page redirect the viewer's tab;
    // allow-popups is how a popunder opens. Neither is worth an embed.
    const iframe = overlays.match(/<iframe className="embed-frame"[\s\S]*?\/>/)[0];
    expect(iframe).not.toMatch(/allow-top-navigation/);
    expect(iframe).not.toMatch(/allow-popups/);
  });

  it('sends no referrer to the provider', () => {
    const iframe = overlays.match(/<iframe className="embed-frame"[\s\S]*?\/>/)[0];
    expect(iframe).toMatch(/referrerPolicy="no-referrer"/);
  });

  it('renders nothing when a title has no embeddable provider', () => {
    // With mapple's iframe_ok cleared, most titles now offer zero embeds. That
    // must be a clean absence, not a broken panel.
    expect(overlays).toMatch(/if \(!embeds\?\.length\) return null;/);
  });
});
