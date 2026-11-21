import { languageCandidates } from './languageSources';
import { PREFERRED_LANGUAGE } from '../backend';
import { markDead, nextAlive } from './deadSources';

/**
 * One SOURCE switch, from the click to a decoded frame or a verdict of dead.
 *
 * Owner complaint (2026-11-20): switching to any server "doesn't respond for a
 * while, looks frozen". Two causes in the old flow:
 *   1. The overlay's landing poll watched the OLD stream. During a language
 *      pairing the old picture keeps playing while /hybrid/pair runs, so the
 *      poll saw the clock move and cleared the overlay after ~1s, and took the
 *      12s backstop with it. The click then looked like it did nothing.
 *   2. A provider that answered SOMETHING (a manifest, no frame) passed the
 *      12s "any sign of life" check and was never judged again.
 *
 * So the switch is judged only on the NEW stream (`attached`), with two
 * bounds:
 *   SWITCH_NO_LIFE_MS  new stream attached, but no manifest, no buffer, no
 *                      metadata: the origin is not
 *                      answering. 8s. A healthy proxied master answers in a
 *                      second or two (and a warmed one is in the proxy's
 *                      segment cache), while hls.js itself would sit up to
 *                      20s x 4 tries on a dead origin (hlsConfig.js
 *                      manifestLoadingTimeOut 20000, MaxRetry 3).
 *   SWITCH_HARD_MS     something arrived but no frame. 20s. First frames of
 *                      14-19s were measured on slow devices for streams that
 *                      then played (Player.jsx STARTUP_SWITCH_MS note), so a
 *                      live-but-slow server gets that long, and no longer.
 * The old flow waited 12s + 6s = 18s and then only showed an error.
 */
export const SWITCH_NO_LIFE_MS = 8000;
export const SWITCH_HARD_MS = 20000;
export const SWITCH_TICK_MS = 500;

/**
 * Any sign the new stream is alive. `videoWidth` is left out on purpose: the
 * element keeps the PREVIOUS source's dimensions after a failed attach
 * (measured on 1408162, videoWidth read 1722 with VaPlayer down).
 */
export function hasLife(v) {
  return Boolean(v && (
    v.buffered?.length > 0
    || (Number.isFinite(v.duration) && v.duration > 0)
    || v.readyState >= 2
  ));
}

/**
 * State: null, or { target, label, at, ctx, startedAt, streamKey, phase }.
 *   phase 'requested'  clicked; the new stream is not attached yet (a pairing
 *                      may still be running). The old picture may be playing.
 *   phase 'loading'    the new stream is attached; waiting for a frame.
 * Terminal verdicts are returned by tick(), and the state goes back to null.
 */
export function beginSourceSwitch({ target, label, at = 0, ctx = {}, streamKey = null, now = Date.now() }) {
  return {
    target, label: label || target?.provider || 'That server',
    at, ctx: { lang: ctx.lang || null, height: ctx.height || null, ...(ctx.strictLanguage ? { strictLanguage: true, ...(ctx.fallback ? { fallback: ctx.fallback } : {}) } : {}) },
    startedAt: now, streamKey, phase: 'requested',
  };
}

/**
 * One look at the switch. Returns { state, verdict } with verdict one of
 * 'wait' | 'landed' | 'dead'. `streamKey` is the stream on screen now; it
 * differs from the one at begin once the new stream is attached. `frames` is
 * true once the new stream fired `playing` or reached readyState >= 3.
 */
export function tickSourceSwitch(state, { streamKey, frames = false, alive = false, now = Date.now() }) {
  if (!state) return { state: null, verdict: 'wait' };
  const attached = streamKey !== state.streamKey;
  const next = attached && state.phase === 'requested' ? { ...state, phase: 'loading' } : state;
  if (attached && frames) return { state: null, verdict: 'landed' };
  const elapsed = now - state.startedAt;
  // Before attach (a pairing still running on the backend) there is nothing
  // to look at yet, so only the hard cap applies.
  if (elapsed >= SWITCH_HARD_MS || (attached && elapsed >= SWITCH_NO_LIFE_MS && !alive)) {
    return { state: null, verdict: 'dead' };
  }
  return { state: next, verdict: 'wait' };
}

/**
 * Where to go after a switch failed: mark the target dead, then the next
 * alive row in the language that was playing AT THE CLICK. The context is
 * snapshotted then because a dead attach has no audio tracks, and reading the
 * live context would drop the language and let a Hindi row win on list order.
 * With no language known the preferred language (Telugu) leads.
 */
export function advanceTarget(sources, dead, failed, ctx = {}) {
  if (failed) markDead(dead, { id: failed.id ?? null, provider: failed.provider ?? null });
  return nextAlive(ctx.strictLanguage ? languageCandidates(sources, ctx.lang).filter(s => !s.unsupported) : sources, dead, {
    lang: ctx.lang || PREFERRED_LANGUAGE,
    height: ctx.height || null,
  });
}

// The advance copy lives in loadingModel.js, shared with the APK's
// LoadingModel.kt: "{from} didn't start. Trying {to}."
export { advanceNotice } from './loadingModel';
