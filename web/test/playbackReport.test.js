import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const player = readFileSync(fileURLToPath(new URL('../components/Player.jsx', import.meta.url)), 'utf8');
const api = readFileSync(fileURLToPath(new URL('../lib/api.js', import.meta.url)), 'utf8');

/**
 * The browser is the only thing that knows whether a source really plays.
 *
 * `validated_at` on the resolver means a segment range request returned bytes
 * FROM THE VM - Karuppu's mapple row validated fine and then stalled, while
 * vidking played immediately. Until now that knowledge died with the tab.
 */
describe('reporting a playback outcome', () => {
  it('never lets telemetry break playback', () => {
    // A report must not delay a frame or surface an error. With no sink there
    // is nothing to throw, and the guarantee is now structural: the body does
    // no I/O at all. If a transport comes back it must be wrapped again.
    const fn = api.match(/export function reportPlayback[\s\S]*?\n}/)[0];
    expect(fn).not.toMatch(/fetch\(/);
  });

  it('has no sink, and says so rather than posting to a dead endpoint', () => {
    // `/api/playback-report` lived on the resolver and 404s on the local
    // backend (measured 2026-09-22). Posting anyway put one failed request in
    // the network panel per fatal, per codec refusal and per successful start.
    // Checks for a REQUEST to it, not a mention of it: the removal note in the
    // header names the endpoint on purpose, and that must stay greppable.
    const fn = api.match(/export function reportPlayback[\s\S]*?\n}/)[0];
    expect(fn).not.toMatch(/fetch\(/);
    expect(fn).not.toMatch(/playback-report/);
    expect(fn).toMatch(/NO SINK/);
  });

  it('declines to report without a provider or title', () => {
    // A report the resolver cannot key to a cache row is noise.
    const fn = api.match(/export function reportPlayback[\s\S]*?\n}/)[0];
    expect(fn).toMatch(/if \(!provider \|\| !tmdbId\) return;/);
  });

  it('keeps the signature and every call site, so it can be switched back on', () => {
    // The player is the only thing that knows whether a stream actually PLAYED
    // on a real device. Deleting the calls would lose that wiring; only the
    // transport is gone.
    expect(api).toMatch(/export function reportPlayback\(/);
    expect(player.match(/reportPlayback\(/g).length).toBeGreaterThanOrEqual(6);
  });
});

describe('when the player reports', () => {
  it('reports success on the first frame, not on play', () => {
    // `play` fires when playback is REQUESTED, long before a frame exists.
    // Reporting there would mark a source good that never rendered anything.
    expect(player).toMatch(/addEventListener\('playing', onPlaying\)/);
    expect(player).toMatch(/reportedRef\.current = true/);
  });

  it('reports failure whenever a source is abandoned', () => {
    // recoverBySwitching is the single place a source is given up on, whether
    // that came from a 403 or a stall.
    const fn = player.match(/const recoverBySwitching = useCallback[\s\S]*?\n  \}, \[/)[0];
    expect(fn).toMatch(/reportPlayback\(\{[\s\S]*?ok: false/);
  });

  it('reports once per stream, and again after a switch', () => {
    // Without the reset a switched-to source plays but never reports, so it
    // looks untried forever while the abandoned one keeps its failure.
    expect(player).toMatch(/reportedRef\.current = false/);
  });

  it('keeps startupMs on the stream clock, because it is a control input', () => {
    // startupMs is NOT just a stat. The resolver compares it against
    // cachedStartupMaxMs (8000) to decide whether to skip a cached source, and
    // weights it 1.5x in RANK. Measured p50 startup was already 8001ms, so
    // folding the resolve leg in (1.3s cache hit, 14.4s cold) would push
    // ordinary rows past the threshold and skip caches that play fine.
    const fn = player.match(/const reportMetrics = useCallback[\s\S]*?\n  \}, \[/)[0];
    expect(fn).toMatch(/startupMs: streamStartedAt\.current \? Date\.now\(\) - streamStartedAt\.current : 0/);
    // and it must not be the one carrying the request clock
    expect(fn).not.toMatch(/startupMs: requestedAtRef/);
  });

  it('reports the press-to-picture wait as its own field', () => {
    // The number the viewer actually feels. Sent ALONGSIDE startupMs so the
    // two clocks never share a column and the gap between them is the resolve
    // cost; the resolver stores it in wait_ms.
    const fn = player.match(/const reportMetrics = useCallback[\s\S]*?\n  \}, \[/)[0];
    expect(fn).toMatch(/waitMs: requestedAtRef\.current\?\.current/);
    // The field survives on the signature even with no transport, so wiring it
    // to a collector later needs no change at the call sites.
    expect(api).toMatch(/startupMs = 0, waitMs = 0/);
  });

  it('times the wait from the request, and re-stamps on a switch', () => {
    // Stamped in load() so a refresh is its own fresh wait, and in
    // switchSource() so a switch mid-film is not measured against the original
    // press - which would report a several-minute startup.
    const hook = readFileSync(fileURLToPath(new URL('../lib/player/useResolve.js', import.meta.url)), 'utf8');
    const load = hook.match(/const load = useCallback[\s\S]*?\n  \}, \[/)[0];
    expect(load).toMatch(/requestedAt\.current = Date\.now\(\)/);
    const sw = hook.match(/const switchSource = useCallback[\s\S]*?\n  \}, \[/)[0];
    expect(sw).toMatch(/requestedAt\.current = Date\.now\(\)/);
    // and the hook must actually hand it to the player
    expect(hook).toMatch(/requestedAt,/);
  });

  it('reads live values through a ref, not a stale closure', () => {
    // The media listeners are attached once per stream. Closing over props
    // would capture the values from that render and report the wrong provider.
    expect(player).toMatch(/reportCtx\.current = \{/);
    const onPlaying = player.match(/const onPlaying = \(\) => \{[\s\S]*?\n    \};/)[0];
    expect(onPlaying).toMatch(/reportCtx\.current/);
  });
});
