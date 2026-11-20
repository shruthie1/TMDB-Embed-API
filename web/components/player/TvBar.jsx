'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { audioOptions } from '../../lib/player/audioOptions';

/**
 * Source and quality controls for a TV, rendered OUTSIDE the video element.
 *
 * On Fire TV the video carries native `controls`: Amazon built and tested that
 * bar against their own remote, so play, seek and the volume behave correctly
 * without any of our own key handling. What native controls cannot offer is a
 * choice of PROVIDER - and on a TV that is the control that matters most,
 * because switching source is the real remedy for buffering.
 *
 * So this is deliberately the least clever thing that works: plain buttons in
 * labelled rows, no popover, no sheet, no gesture layer. A button either has
 * focus or it does not, and OK presses it.
 *
 * The "Silk is Chrome 70" caveat this comment used to carry is out of date:
 * Silk reports `Silk/146 like Chrome/146` (verified May 2026). The layout is
 * still conservative - a CSS grid and `gap`, nothing newer - but the rows are
 * now [label][buttons] rather than one flex line, because flex-wrap could not
 * align the first button of each row to a common edge and that misalignment
 * was the reported defect.
 */
/** Long enough to read the row and press a button, short enough to get out of
 *  the way of the film. */
const IDLE_MS = 6000;
/** Longer while focus is in the bar: reading a row takes longer than leaving
 *  it, but it must still end - a bar that never hides covers the film. */
const HOLD_MS = 10000;

const sourceMeta = (source) => {
  // Language and quality FIRST, because a provider that ships one stream per
  // language renders as several buttons with the same provider name: 628241
  // showed five identical "CastleTV" buttons with nothing to choose between
  // them. These are what actually distinguish one row entry from the next.
  const langs = (source.languages || []).join('/');
  const bits = [langs, source.quality, source.best, source.codecs?.video];
  if ((source.audioTracks?.length || 0) > 1) bits.push(`${source.audioTracks.length} audio`);
  return bits.filter(Boolean).join(' · ');
};

// Which stream is playing, by IDENTITY not by provider name. Comparing on
// `provider` marked every CastleTV button as selected at once, so the row
// could not show which of them was actually on.
const isCurrent = (s, currentSourceId, currentSource) => (
  s.id != null && currentSourceId != null
    ? s.id === currentSourceId
    : s.provider === currentSource);

export default function TvBar({
  sources = [], currentSource, currentSourceId, onPickSource,
  levels = [], currentLevel, autoLevel, onPickLevel,
  audioTracks = [], currentAudio, onPickAudio,
  sourcesPending = false, onClose,
  fit = 'cover', onSetFit,
  subs = [], currentSub, onPickSub, subLoading = false,
}) {
  /**
   * The bar hides itself.
   *
   * It used to sit over the bottom of the picture permanently, which is worse
   * than no bar at all on a screen you watch from across the room. Any remote
   * press brings it back and restarts the clock, exactly like the control bar
   * on every other device.
   *
   * Kept on while focus is INSIDE the bar: hiding the row someone is currently
   * navigating would be the same mistake in the opposite direction.
   */
  const [shown, setShown] = useState(true);
  // Set by the effect below; a selection calls it so choosing a source
  // restarts the idle clock rather than waiting for another keypress.
  const rearm = useRef(() => {});
  const timer = useRef(null);
  const holding = useRef(false);
  // Read through a ref: the listener is attached once, so reading `shown`
  // directly would always see whatever it was on the first render.
  const shownRef = useRef(true);
  shownRef.current = shown;
  /**
   * Whether the viewer has interacted recently.
   *
   * The opener used to be permanently visible, which looks bad over a film.
   * It now follows activity instead: a tap or a remote press brings it back,
   * and it fades with the same idleness that hides the native controls - so it
   * is there exactly when you are reaching for something, and gone while you
   * are watching.
   */
  const [active, setActive] = useState(true);
  const activeTimer = useRef(null);

  useEffect(() => {
    /**
     * Arm the idle timer.
     *
     * It ALWAYS arms, even with focus inside the bar - `holding` used to veto
     * it entirely, and after selecting a source the focus stays on the button
     * you pressed, so holding never cleared and the bar stayed up for the rest
     * of the film. Focus inside just buys a longer window, because someone
     * reading the row needs more time than someone who walked away from it.
     */
    const arm = () => {
      clearTimeout(timer.current);
      const ms = holding.current ? HOLD_MS : IDLE_MS;
      timer.current = setTimeout(() => setShown(false), ms);
    };
    /**
     * A press TOGGLES the bar rather than always revealing it.
     *
     * Reveal-only meant the bar could only be dismissed by waiting out the
     * timer, which reads as unreliable - you press to get rid of it and it
     * stays. Pressing while it is up and focus is NOT inside it now hides it
     * immediately. A press aimed at a button inside the bar still counts as
     * use, so navigating never dismisses what you are navigating.
     */
    const wake = (e) => {
      // `holding` is set by focusin, which has ALREADY fired by the time a
      // later keydown arrives. Reading document.activeElement here instead was
      // the bug: on a keydown the focus has not moved yet, so the first press
      // inside the bar read as "outside" and dismissed the row being
      // navigated - worse than never hiding at all.
      if (shownRef.current && !holding.current) {
        clearTimeout(timer.current);
        setShown(false);
        return;
      }
      setShown(true);
      arm();
    };
    // Any remote press. Not mousemove: a TV has no pointer, and on the devices
    // that synthesise one it fires constantly.
    /**
     * Activity, from a tap ANYWHERE on the player as well as the remote.
     *
     * Tapping above or below the seeker used to summon the controls, and
     * losing that is what made the always-visible button necessary. Pointer
     * events are captured on the player itself, so a tap on the picture
     * counts even though the native control bar handles its own presses.
     */
    const touch = () => {
      setActive(true);
      clearTimeout(activeTimer.current);
      activeTimer.current = setTimeout(() => setActive(false), IDLE_MS);
    };
    const surface = document.querySelector('.player');
    ['pointerdown', 'click', 'touchstart'].forEach(n =>
      surface?.addEventListener(n, touch, true));
    window.addEventListener('keydown', touch);
    touch();

    window.addEventListener('keydown', wake);
    const onFocus = () => {
      holding.current = !!document.activeElement?.closest?.('.tvbar');
      // Focus arriving IN the bar is use, not a dismissal - reveal and hold.
      if (holding.current) { setShown(true); arm(); return; }
      arm();
    };
    window.addEventListener('focusin', onFocus);
    rearm.current = arm;
    arm();
    return () => {
      clearTimeout(timer.current);
      clearTimeout(activeTimer.current);
      ['pointerdown', 'click', 'touchstart'].forEach(n =>
        surface?.removeEventListener(n, touch, true));
      window.removeEventListener('keydown', touch);
      window.removeEventListener('keydown', wake);
      window.removeEventListener('focusin', onFocus);
    };
  }, []);
  // Quality is offered as Auto plus the rungs, since a TV that cannot decode
  // 4K in real time rebuffers in a way that looks exactly like a slow network.
  const rungs = [{ index: -1, label: autoLevel ? `Auto (${autoLevel})` : 'Auto' },
                 ...levels];

  // Language, the control this bar was missing.
  //
  // Silk's native player exposes no audio-track menu, and TvBar rendered
  // Source/Quality/Captions/Picture but nothing for audio - so on a Fire TV
  // there was no way to choose a language at all. On a Telugu-first library
  // that is the single most important switch on the screen.
  //
  // audioOptions already answers "what can this title be heard in", whether
  // the answer is in-file renditions or, as on the native path where hls.js
  // never attaches and audioTracks is always [], sibling single-language
  // sources. Reused rather than reimplemented so the TV and the custom player
  // can never disagree about which languages exist.
  const audio = useMemo(
    () => audioOptions({ audioTracks, currentAudio, sources, currentSourceId }),
    [audioTracks, currentAudio, sources, currentSourceId]);

  return (
    <>
      {/* An always-visible opener.
          The bar could only be summoned by a keydown on `window`, and Fire
          TV's native controls swallow the remote's presses - so once it hid
          itself there was no way back to it. Silk's own three-dots menu holds
          only its native items (captions, speed) and cannot be extended, so
          our sources need a button of our own. Small, cornered, and never
          hidden: it is the one thing that must always be reachable. */}
      {!shown && active && (
        <button type="button" className="tvbar-open focusable" data-focus=""
                aria-label="Sources and picture settings"
                onClick={() => { setShown(true); rearm.current(); }}>
          {/* An icon, not the word: a label sitting over the picture reads as
              clutter, and the sliders glyph is the same one the phone and
              laptop use for these settings. Drawn inline rather than through
              Icon, which returns null for a name it does not know - that is
              how the seek buttons once became invisible. */}
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
               fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" />
          </svg>
        </button>
      )}

    <div className={`tvbar ${shown ? 'show' : ''}`} data-focus-group="">
      <div className="tvbar-row" data-focus-group="">
        <span className="tvbar-k">Source</span>
        {/* The buttons live in their own box so the row can be a two-column
            grid: a fixed label column, then everything else. That is what
            makes every row's first button share one left edge - with the
            buttons as direct children of a flex row they could not. */}
        <div className="tvbar-btns">
          {sources.map(s => (
            // `key={s.provider}` collided whenever one provider ships several
            // streams - CastleTV returns one PER LANGUAGE, so 628241 rendered
            // five buttons under one key and React warned it may omit some.
            // `id` is the stream identity the rest of the player already uses.
            <button key={s.id ?? s.provider} type="button"
                    className={`tvbar-btn focusable ${isCurrent(s, currentSourceId, currentSource) ? 'on' : ''}`}
                    data-focus=""
                    aria-pressed={isCurrent(s, currentSourceId, currentSource)}
                    onClick={() => { onPickSource?.(s); rearm.current(); }}>
              {s.provider}{sourceMeta(s) ? ` · ${sourceMeta(s)}` : ''}
            </button>
          ))}
          {sourcesPending && <span className="tvbar-note">finding more…</span>}
        </div>
      </div>

      {rungs.length > 1 && (
        <div className="tvbar-row" data-focus-group="">
          <span className="tvbar-k">Quality</span>
          <div className="tvbar-btns">
            {rungs.map(l => (
              <button key={l.index} type="button"
                      className={`tvbar-btn focusable ${l.index === currentLevel ? 'on' : ''}`}
                      data-focus=""
                      aria-pressed={l.index === currentLevel}
                      onClick={() => { onPickLevel?.(l.index); rearm.current(); }}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Language.
          Only shown when there is a real choice: a single-language title needs
          no row, and an empty one would be a dead control on a remote. A
          'muxed' option switches the track inside the file; a 'sources' option
          switches to the sibling stream that carries that language, which is
          how CastleTV ships Telugu/Malayalam/Hindi. */}
      {audio.options.length > 1 && (
        <div className="tvbar-row" data-focus-group="">
          <span className="tvbar-k">Audio</span>
          <div className="tvbar-btns">
            {audio.options.map(o => (
              <button key={`${o.kind}:${o.id}`} type="button"
                      className={`tvbar-btn focusable ${o.id === audio.current ? 'on' : ''}`}
                      data-focus="" aria-pressed={o.id === audio.current}
                      onClick={() => {
                        // An in-file switch keeps the playback position, so it
                        // is always preferred when the menu offers one.
                        if (audio.kind === 'muxed' && onPickAudio?.(o.id) !== false) {
                          rearm.current();
                          return;
                        }
                        // Otherwise the language lives in another stream:
                        // onPickSource takes the SOURCE OBJECT, not an id.
                        const next = sources.find(x => x.id === o.id);
                        if (next) onPickSource?.(next, o.name);
                        rearm.current();
                      }}>
                {o.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Captions.
          Silk's own three-dots menu was EMPTY because nothing on this path ever
          selected a track: subUrl is null until one is picked, so no <track>
          element existed for the UA to list. This row does the selecting; Silk
          still paints the cues, which is the point of the native path - our own
          cue overlay is the code that could not be verified on Chrome 70.

          Capped at three variants: the list is English-only with release names
          (WEB-DL, Blu-ray, SDH) and a long row of near-identical labels is
          unreadable from across a room. */}
      {subs.length > 0 && (
        <div className="tvbar-row" data-focus-group="">
          <span className="tvbar-k">Captions</span>
          <div className="tvbar-btns">
            <button type="button"
                    className={`tvbar-btn focusable ${!currentSub ? 'on' : ''}`}
                    data-focus="" aria-pressed={!currentSub}
                    onClick={() => { onPickSub?.(null); rearm.current(); }}>
              Off
            </button>
            {subs.slice(0, 3).map(t => (
              <button key={t.id} type="button"
                      className={`tvbar-btn focusable ${t.id === currentSub ? 'on' : ''}`}
                      data-focus="" aria-pressed={t.id === currentSub}
                      onClick={() => { onPickSub?.(t.id); rearm.current(); }}>
                {t.name}{t.id === currentSub && subLoading ? ' …' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Picture fit. Named buttons, not the cycling icon the custom player
          uses: on a remote there is no hover to reveal what an icon means, and
          three visible options need no discovering. */}
      <div className="tvbar-row" data-focus-group="">
        <span className="tvbar-k">Picture</span>
        <div className="tvbar-btns">
          {[['contain', 'Fit whole'], ['cover', 'Fill screen'], ['fill', 'Stretch']]
            .map(([mode, label]) => (
              <button key={mode} type="button"
                      className={`tvbar-btn focusable ${fit === mode ? 'on' : ''}`}
                      data-focus=""
                      aria-pressed={fit === mode}
                      onClick={() => { onSetFit?.(mode); rearm.current(); }}>
                {label}
              </button>
            ))}
        </div>
      </div>

      {/* No label, but the button still starts in the buttons column - the
          grid keeps the empty label cell, so Close lines up with Fit whole
          above it instead of hanging 73px out to its left. */}
      <div className="tvbar-row" data-focus-group="">
        <div className="tvbar-btns">
          <button type="button" className="tvbar-btn focusable" data-focus=""
                  onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
    </>
  );
}
