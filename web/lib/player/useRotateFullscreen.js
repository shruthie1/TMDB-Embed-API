'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isTvDevice } from './hlsConfig';

/**
 * Rotate-to-fullscreen, the way every OTT app behaves.
 *
 * Turning a phone sideways does NOT fullscreen a <video> by itself. Nothing in
 * the platform does this; it is entirely something the page has to implement,
 * which is why the player had a Fullscreen button and nothing else.
 *
 * ── The constraint that shapes this whole hook ────────────────────────────
 *
 * `Element.requestFullscreen()` requires TRANSIENT USER ACTIVATION, and the
 * HTML spec lists exactly which events grant it: keydown, mousedown,
 * pointerdown (mouse), pointerup (non-mouse), and touchend. `orientationchange`
 * is NOT among them, and neither is `resize` or a matchMedia change.
 *
 * So the obvious implementation — listen for the rotation, call
 * requestFullscreen — is calling a gesture-gated API from a context that has no
 * gesture. It is rejected with a NotAllowedError.
 *
 * The way out is that activation is TRANSIENT, not instantaneous: it survives
 * for a few seconds after a real interaction. A viewer who has just tapped play,
 * tapped the picture, or touched the control bar is inside that window, and a
 * request made then is honoured. That is what "arming" below means — we record
 * the last real touch, and on rotation we only attempt fullscreen if that touch
 * is recent enough to still be carrying activation.
 *
 * When it is not, we do not call the API and let it fail silently. We retain
 * `needsTap` as diagnostic state for tests/consumers, but the player does not
 * surface a chip or notification: rotation/fullscreen is deliberately quiet.
 *
 * ── iOS Safari ────────────────────────────────────────────────────────────
 *
 * iPhone Safari does not implement the Fullscreen API on arbitrary elements
 * (iPadOS 16.4+ does; iPhone does not). The only fullscreen available is
 * `video.webkitEnterFullscreen()`, which hands playback to Apple's NATIVE
 * player — losing our control bar, our source switcher, and our custom
 * subtitle rendering, which is the whole reason the player draws its own cues.
 *
 * We therefore do NOT call it on rotation. `canRotateFullscreen` reports false
 * there, and the player keeps its own UI. This is a real platform gap and is
 * reported as one rather than papered over.
 *
 * @param {object} opts
 * @param {{current: HTMLElement|null}} opts.boxRef  element to fullscreen
 * @param {boolean} [opts.enabled]  false while there is nothing to play
 */

/**
 * How long after a touch we still believe we hold activation.
 *
 * The spec does not pin the transient activation window; Chrome uses five
 * seconds. We stay under it deliberately: a request that is refused costs the
 * viewer a silent no-op, whereas being slightly conservative costs them a
 * visible tap prompt that still works.
 */
export const ARM_MS = 3000;

/** Does this element support being fullscreened at all? */
function canFullscreenElement(el) {
  return typeof el?.requestFullscreen === 'function';
}

/**
 * iPhone/iPod Safari, where only `video.webkitEnterFullscreen` exists.
 *
 * iPad is excluded: iPadOS 16.4 added real Element.requestFullscreen, and
 * modern iPads report a desktop-Mac UA anyway, so the element check above is
 * the one that actually decides. This is only used to explain the gap.
 */
function isIosPhoneSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

export function useRotateFullscreen({ boxRef, enabled = true } = {}) {
  /** Set when a rotation wanted fullscreen but we had no activation to spend. */
  const [needsTap, setNeedsTap] = useState(false);
  const [canRotateFullscreen, setCan] = useState(false);

  /** Timestamp of the last real user touch, our proxy for transient activation. */
  const armedAt = useRef(0);
  /**
   * Did WE put the page into fullscreen?
   *
   * Without this, exiting by Escape or the system back gesture while still
   * holding the phone sideways would be immediately undone by our own
   * landscape handler, and the viewer could never get out.
   */
  const ours = useRef(false);
  /** The user overrode us in this orientation; stay out until they rotate away. */
  const userExited = useRef(false);

  /**
   * Record a real interaction. The player calls this from its existing tap
   * handlers — the play button, the picture, the control bar.
   */
  const arm = useCallback(() => { armedAt.current = Date.now(); }, []);

  const enter = useCallback(async () => {
    const el = boxRef?.current;
    if (!canFullscreenElement(el)) return false;
    if (document.fullscreenElement) return true;
    try {
      // Claim it BEFORE awaiting. `fullscreenchange` fires as soon as the
      // request is honoured, which can be before this promise resolves, and
      // that handler needs to already know the entry was ours — otherwise it
      // reads our own success as the user exiting.
      ours.current = true;
      await el.requestFullscreen();
      setNeedsTap(false);
      // Only meaningful once fullscreen, and unsupported on plenty of
      // browsers (all of desktop, and Safari everywhere). A failure here is
      // cosmetic — we are already fullscreen — so it must not reject upward.
      try { await screen.orientation?.lock?.('landscape'); } catch { /* not supported */ }
      return true;
    } catch {
      // Refused for want of activation. Ask for the tap instead of failing mute.
      ours.current = false;
      setNeedsTap(true);
      return false;
    }
  }, [boxRef]);

  const exit = useCallback(async () => {
    try { screen.orientation?.unlock?.(); } catch { /* not supported */ }
    if (!document.fullscreenElement) return;
    try { await document.exitFullscreen?.(); } catch { /* already gone */ }
  }, []);

  /** Optional programmatic consumer path; the player keeps rotation UI silent. */
  const fullscreenFromTap = useCallback(() => {
    arm();
    userExited.current = false;
    return enter();
  }, [arm, enter]);

  // Establish what this device can actually do, once mounted. Deferred to an
  // effect because it touches navigator/DOM and must not diverge between the
  // server render and the first client one.
  useEffect(() => {
    if (!enabled) { setCan(false); return; }
    if (isTvDevice()) { setCan(false); return; }
    setCan(canFullscreenElement(boxRef?.current));
  }, [enabled, boxRef]);

  // Track fullscreen leaving under us — Escape, the system back gesture, or
  // the browser's own control. The UI must follow reality, not our intent.
  useEffect(() => {
    if (!enabled) return;
    const onChange = () => {
      if (document.fullscreenElement) return;
      // Gone. If we did not ask for it to go, the user did.
      if (ours.current) userExited.current = true;
      ours.current = false;
      setNeedsTap(false);
      try { screen.orientation?.unlock?.(); } catch { /* not supported */ }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [enabled]);

  // The rotation itself.
  useEffect(() => {
    if (!enabled) return;
    // A television is a fixed landscape panel. It never rotates, and forcing
    // fullscreen on it would fight the 10-foot layout.
    if (isTvDevice()) return;
    if (typeof window.matchMedia !== 'function') return;

    const mql = window.matchMedia('(orientation: landscape)');

    const onOrientation = (e) => {
      const landscape = e?.matches ?? mql.matches;
      if (landscape) {
        // The user deliberately left fullscreen while sideways; respect that
        // until they rotate back to portrait and change their mind.
        if (userExited.current) return;
        if (document.fullscreenElement) return;
        if (!canFullscreenElement(boxRef?.current)) return;
        // Do we still hold activation? If not, requesting would only earn a
        // NotAllowedError, so ask for the tap that will actually work.
        if (Date.now() - armedAt.current > ARM_MS) { setNeedsTap(true); return; }
        enter();
      } else {
        // Back to portrait: leave fullscreen, and clear the override so the
        // next rotation to landscape behaves normally again.
        userExited.current = false;
        setNeedsTap(false);
        if (ours.current || document.fullscreenElement) exit();
      }
    };

    // Safari below 14 has only the deprecated listener form.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onOrientation);
    } else {
      mql.addListener(onOrientation);
    }
    // Some mobile WebViews do not update matchMedia reliably. Also evaluate
    // immediately: playback may become ready after the phone was already
    // rotated, so there may be no future orientation event to observe.
    window.addEventListener('orientationchange', onOrientation, { passive: true });
    onOrientation({ matches: mql.matches });
    return () => {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', onOrientation);
      } else {
        mql.removeListener(onOrientation);
      }
      window.removeEventListener('orientationchange', onOrientation);
    };
  }, [enabled, boxRef, enter, exit]);

  return {
    /** Can a rotation put THIS device into our own fullscreen? */
    canRotateFullscreen,
    /** True when a rotation needs a tap to complete. */
    needsTap,
    /** Why, when it cannot — for an honest message rather than silence. */
    reason: canRotateFullscreen ? null
      : isIosPhoneSafari() ? 'ios-native-only' : 'unsupported',
    arm,
    fullscreenFromTap,
    dismissTap: useCallback(() => setNeedsTap(false), []),
  };
}
