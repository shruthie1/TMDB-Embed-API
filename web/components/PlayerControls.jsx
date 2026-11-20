'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import MenuRow from './player/MenuRow';
import QualityMenu from './player/QualityMenu';
import AudioMenu from './player/AudioMenu';
import VideoMenu from './player/VideoMenu';
import { audioOptions } from '../lib/player/audioOptions';
import { videoChoices, audioChoices, pairingFor, videoIdOf } from '../lib/player/trackChoices';
import { SIZES } from '../lib/subtitles';

// How long the settings sheet stays open with no interaction. Short, because
// it covers the picture; any action inside it restarts the clock.
const SHEET_IDLE_MS = 3000;
// A remote is slower than a pointer: reading a row and pressing Down took
// longer than 3s, and the sheet closed under the viewer's thumb.
const SHEET_IDLE_TV_MS = 10000;

const fmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
           : `${m}:${String(sec).padStart(2, '0')}`;
};


// The selectable row moved to components/player/MenuRow.jsx so the settings
// sheet and the standalone quality/audio menus share one implementation.
const Row = MenuRow;

export function sourceMeta(source) {
  const bits = [source.best];
  // Languages FIRST: on a multi-language Indian release the provider often
  // returns several streams and every row then reads just "CastleTV", with no
  // way to tell the Telugu one from the Kannada one without picking blind
  // (measured on 1511417: 4 identical CastleTV rows). `best`/`codecs` come
  // from capability probing, which is opt-in and usually absent, so without
  // this the meta line is empty for most rows.
  const langs = Array.isArray(source.languages) ? source.languages.filter(Boolean) : [];
  if (langs.length) bits.push(langs.length > 3 ? `${langs.slice(0, 3).join(', ')} +${langs.length - 3}` : langs.join(', '));
  const video = source.codecs?.video;
  if (video) bits.push(video);
  const audio = source.audioTracks?.length || 0;
  if (audio > 1) bits.push(`${audio} audio`);
  // Quality disambiguates same-provider rows that differ only by rung
  // (CastleTV returns 720p and 480p of the same file).
  if (!source.best && source.quality && source.quality !== 'Auto') bits.push(source.quality);
  return bits.filter(Boolean).join(' · ');
}

/**
 * Source and subtitle settings.
 *
 * Quality and audio USED to live here as groups three and five. They are the
 * two settings people actually reach for mid-playback - resolution on a weak
 * line, language on a multi-audio Indian release - and burying them cost a tap
 * to open, a scroll past the other groups, and a second tap, with no way to
 * see the current value without opening the sheet at all. Both now have their
 * own button in the control row (QualityMenu, AudioMenu) showing the active
 * value on the face.
 *
 * What is left is the subtitle track plus its size and timing. The provider
 * list moved out to its own "Servers" control on 2026-09-22, so this sheet no
 * longer duplicates it.
 */
function SettingsSheet({ subs, currentSub, onPickSub, subLoading, subPrefs, onSubPrefs,
                          onClose, picks }) {
  return (
    <>
      <div className="pmenu-sheet-head">
        <span>Settings</span>
        <button className="icon-btn focusable" data-focus="" aria-label="Close settings" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="pmenu-sheet-body">
      {/* The provider list used to live here. It moved out to its own
          "Servers" control in the row on 2026-09-22: with a dedicated button
          showing the provider and the best quality it supports, repeating the
          same list behind Settings was two places to change one thing, and
          the sheet is now just subtitles. */}

      {/* Phones: quality, server and audio live here, as rows that open their
          list in place, so the control row keeps one settings button. */}
      {picks && <div className="pmenu-group sheet-picks">{picks}</div>}

      {subs.length > 0 && (
        <div className="pmenu-group">
          <p className="pmenu-label">Subtitles</p>
          <Row label="Off" selected={!currentSub} onClick={() => onPickSub?.(null)} />
          {subs.map(t => (
            <Row key={t.id} label={t.name} selected={t.id === currentSub}
                 loading={t.id === currentSub && subLoading}
                 onClick={() => onPickSub?.(t.id)} />
          ))}
          {currentSub && (
            <div className="sub-settings">
              <div className="sub-set-row">
                <span className="sub-set-k">Text size</span>
                <div className="sub-seg" role="group" aria-label="Subtitle size">
                  {SIZES.map(sz => (
                    <button key={sz.key} aria-pressed={subPrefs.scale === sz.key}
                            className={`sub-seg-btn focusable ${subPrefs.scale === sz.key ? 'on' : ''}`} data-focus=""
                            onClick={() => onSubPrefs?.({ scale: sz.key })}>{sz.label}</button>
                  ))}
                </div>
              </div>

              <div className="sub-set-row sub-sync">
                <span className="sub-set-k">Timing</span>
                <div className="sub-sync-ctl">
                  {/* Named for what they DO. A bare -/+ says nothing about
                      which direction the subtitles move. */}
                  <button className="sub-step focusable" data-focus="" aria-label="Subtitles 0.5s earlier"
                          onClick={() => onSubPrefs?.({ offsetMs: subPrefs.offsetMs - 500 })}>
                    −0.5s
                  </button>
                  <span className="sub-sync-val" aria-live="polite">
                    {subPrefs.offsetMs === 0 ? 'In sync'
                      : `${subPrefs.offsetMs > 0 ? 'Later ' : 'Earlier '}${Math.abs(subPrefs.offsetMs / 1000).toFixed(1)}s`}
                  </span>
                  <button className="sub-step focusable" data-focus="" aria-label="Subtitles 0.5s later"
                          onClick={() => onSubPrefs?.({ offsetMs: subPrefs.offsetMs + 500 })}>
                    +0.5s
                  </button>
                </div>
              </div>
              {subPrefs.offsetMs !== 0 && (
                <button className="sub-reset focusable" data-focus=""
                        onClick={() => onSubPrefs?.({ offsetMs: 0 })}>Reset timing</button>
              )}
            </div>
          )}
        </div>
      )}
      </div>
    </>
  );
}

export default function PlayerControls({
  videoRef, hls, title, subtitle, onClose, busy = false,
  visible = true, onReveal, onMenuChange, menuOpen = null, tv = false,
  sources = [], currentSource, currentSourceId = null, onPickSource, sourcesPending = false,
  audioSync = null,
  subs = [], currentSub = null, onPickSub, subLoading = false,
  fit = 'contain', onCycleFit,
  subPrefs = { scale: 1, offsetMs: 0 }, onSubPrefs,
  levels = [], currentLevel = -1, autoLevel, onPickLevel,
  audioTracks = [], currentAudio, onPickAudio, onPickPair,
  embed = null, onPickEmbed,
}) {
  const [state, setState] = useState({ playing: false, t: 0, dur: 0, buffered: 0, muted: false, vol: 1 });
  // Which picker is open. Visibility itself is owned by the player
  // (useControlVisibility) - a single writer, because two of them racing is
  // what made the controls flash, auto-hide and ignore taps three times.
  const [menu, setMenu] = useState(null);

  // Languages, however they arrive. See web/lib/player/audioOptions.js.
  const audioMenu = useMemo(
    () => audioOptions({ audioTracks, currentAudio, sources, currentSourceId }),
    [audioTracks, currentAudio, sources, currentSourceId],
  );

  // Picture and language as two independent lists, so the viewer is not asked
  // to read "showsst+CastleTV" and work out which half is which.
  // See web/lib/player/trackChoices.js.
  const videoList = useMemo(() => videoChoices(sources), [sources]);
  // The Servers rows: our sources, then the VaPlayer embed LAST when the
  // title has one (lib/player/vaEmbed.js).
  const serverList = useMemo(
    () => (embed ? [...videoList, embed] : videoList), [videoList, embed]);
  const audioList = useMemo(
    () => audioChoices(sources, currentSourceId, audioTracks),
    [sources, currentSourceId, audioTracks],
  );

  // What the Audio button actually renders: whatever audioOptions already
  // found (in-file tracks, or sibling single-language sources), PLUS any
  // language that exists only in another provider and has to be paired. The
  // second group is what the removed hybrid row used to cover; now the viewer
  // asks for it directly instead of it being pre-fused into the source list.
  const mergedAudio = useMemo(() => {
    const have = new Set(audioMenu.options.map((o) => String(o.name).toLowerCase()));
    const extra = audioList
      .filter((c) => !have.has(c.language.toLowerCase()))
      .map((c) => ({ id: c.id, name: c.language, kind: c.kind }));
    return [...audioMenu.options, ...extra];
  }, [audioMenu.options, audioList]);
  const openMenu = (next) => { setMenu(next); onMenuChange?.(Boolean(next)); };

  /**
   * The player's Back closes a menu by clearing ITS flag (Player.jsx owns the
   * key). This component owns which menu is open, so without following that
   * flag the sheet stayed on screen after Back, and the next Back left the
   * film with the sheet still drawn.
   */
  useEffect(() => {
    if (menuOpen === false && menu) setMenu(null);
  }, [menuOpen, menu]);

  /**
   * Focus follows the menu on a remote.
   *
   * Opening: focus moves to the selected row (else the first), so OK on the
   * gear lands IN the list rather than leaving the viewer to find it.
   * Closing: the row that had focus is unmounted, which drops focus on the
   * body - lost. It goes back to the button that opened the menu.
   */
  const opener = useRef(null);
  const rootRef = useRef(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (menu) {
      if (!tv) return;
      const list = root.querySelector('[role="menu"]');
      if (!list || list.contains(document.activeElement)) return;
      const target = list.querySelector('.pmenu-item.on[data-focus]')
        || list.querySelector('[data-focus]:not(.icon-btn)')
        || list.querySelector('[data-focus]');
      target?.focus({ preventScroll: true });
      return;
    }
    const a = document.activeElement;
    const lost = !a || a === document.body || !a.isConnected;
    if (lost && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    opener.current = null;
  }, [menu, tv]);

  /**
   * The settings sheet closes itself after a few idle seconds.
   *
   * It used to stay open indefinitely, which left it covering the picture
   * whenever someone opened it and looked away. Any interaction inside it -
   * a click, a key, a scroll through a long language list - restarts the
   * clock, so reading never gets interrupted.
   */
  const sheetTimer = useRef(null);
  const touchSheet = useCallback(() => {
    clearTimeout(sheetTimer.current);
    sheetTimer.current = setTimeout(() => {
      setMenu(null);
      onMenuChange?.(false);
    }, tv ? SHEET_IDLE_TV_MS : SHEET_IDLE_MS);
  }, [onMenuChange, tv]);

  useEffect(() => {
    if (!menu) { clearTimeout(sheetTimer.current); return; }
    touchSheet();
    return () => clearTimeout(sheetTimer.current);
  }, [menu, touchSheet]);
  // Phones get a different control model: settings behind one button, and
  // seeking by double-tap rather than by two more buttons in a cramped row.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width:639px), (pointer:coarse) and (max-width:900px)');
    const on = () => setCompact(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [scrubbing, setScrubbing] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => setState({
      playing: !v.paused, t: v.currentTime, dur: v.duration || 0,
      buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
      muted: v.muted, vol: v.volume,
    });
    // `seeking`/`seeked` matter as much as `timeupdate`: setting currentTime
    // does NOT fire timeupdate while paused or stalled, so without them the
    // scrubber sat still after a click and only jumped once playback resumed.
    // `ratechange` and `waiting`/`playing` keep the rest of the row honest.
    const evts = ['play', 'pause', 'timeupdate', 'progress', 'volumechange',
                  'loadedmetadata', 'durationchange', 'seeking', 'seeked',
                  'waiting', 'playing', 'ratechange'];
    evts.forEach(e => v.addEventListener(e, sync));
    sync();
    return () => evts.forEach(e => v.removeEventListener(e, sync));
  }, [videoRef]);

  const v = () => videoRef.current;
  const toggle = () => { const el = v(); if (el) el.paused ? el.play().catch(() => {}) : el.pause(); };
  const seekTo = (frac) => { const el = v(); if (el?.duration) el.currentTime = el.duration * frac; };

  /**
   * Scrubbing, driven by pointer events.
   *
   * `drag` is the position under the finger while a drag is in progress, as a
   * percentage. It is null when not dragging, so the bar renders `pct` from
   * the video and there is exactly one source of truth at any moment.
   *
   * setPointerCapture is what makes it accurate: the pointer keeps reporting to
   * this element even when it leaves the track, so dragging past either end or
   * above the bar still tracks instead of dropping the gesture.
   *
   * The video is seeked ONCE, on release. A range input's onChange fired for
   * every intermediate value and seeked the decoder each time, which is what
   * made it feel unresponsive - the decoder was doing dozens of seeks for one
   * drag and the picture could not keep up.
   */
  const [drag, setDrag] = useState(null);
  const scrubRef = useRef(null);

  const fracFrom = (clientX) => {
    const el = scrubRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const onScrubDown = (e) => {
    const el = scrubRef.current;
    if (!el || !v()?.duration) return;
    e.preventDefault();
    setScrubbing(true);
    onReveal?.();
    const frac = fracFrom(e.clientX);
    setDrag(frac * 100);
    try { el.setPointerCapture(e.pointerId); } catch { /* older engines */ }

    const move = (ev) => setDrag(fracFrom(ev.clientX) * 100);
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      try { el.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
      seekTo(fracFrom(ev.clientX ?? e.clientX));
      setDrag(null);
      setScrubbing(false);
      // Restart the idle clock: a drag longer than it would otherwise hide
      // the bar the moment the finger lifts.
      onReveal?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  /** Keyboard seeking, which the range input used to provide for free. */
  const onScrubKey = (e) => {
    const el = v();
    if (!el?.duration) return;
    const step = e.shiftKey ? 60 : 5;
    const map = {
      ArrowRight: step, ArrowLeft: -step,
      PageUp: 60, PageDown: -60,
    };
    if (e.key === 'Enter') {
      // OK on the seek bar: a remote has no other key here, and doing nothing
      // read as a dead button.
      el.paused ? el.play().catch(() => {}) : el.pause();
    } else if (e.key in map) {
      el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + map[e.key]));
    } else if (e.key === 'Home') { el.currentTime = 0; }
    else if (e.key === 'End') { el.currentTime = el.duration; }
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const nudge = (d) => { const el = v(); if (el?.duration) el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + d)); };

  // Double-tap left/right seeks; a single tap reveals the controls. Both are
  // handled here, but VISIBILITY is owned by the player - this only asks.
  const [tapHint, setTapHint] = useState(null);   // 'back' | 'fwd' | null
  // Last tap's time and x, for telling a double-tap seek from a single tap.
  // This was read without ever being declared, so the FIRST tap threw
  // "tapRef is not defined" and the handler died before revealing anything -
  // tapping the picture did nothing at all on touch devices.
  const tapRef = useRef({ t: 0, x: 0 });
  const onSurfaceTap = (e) => {
    // Tapping the picture shows or hides the controls - it does NOT toggle
    // playback, which is far too easy to hit by accident while reaching for
    // the screen. The centre button and the control-row button both do that.
    if (!compact) { onReveal?.(); return; }
    const now = Date.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX ?? rect.width / 2) - rect.left;
    const isDouble = now - tapRef.current.t < 300
                     && Math.abs(x - tapRef.current.x) < rect.width * 0.4;
    tapRef.current = { t: now, x };
    // A single tap toggles the controls; only the second tap of a pair seeks.
    if (!isDouble) {
      setTimeout(() => {
        if (Date.now() - tapRef.current.t >= 290) onReveal?.();
      }, 300);
      return;
    }
    // Middle third is neutral, so a mistap near centre does not jump.
    const zone = x < rect.width * 0.35 ? 'back' : x > rect.width * 0.65 ? 'fwd' : null;
    if (!zone) return;
    nudge(zone === 'back' ? -10 : 10);
    setTapHint(zone);
    setTimeout(() => setTapHint(null), 520);
  };

  // Quality, server and audio. In the row on wider screens; on phones they
  // move into the settings sheet (see SettingsSheet), so the row keeps at most
  // five buttons. `back` is where closing one of them returns to.
  const back = compact ? 'all' : null;
  const sheetOpen = menu === 'all' || (compact && ['quality', 'video', 'audio'].includes(menu));
  const picks = (
    <>
          {/* Quality and audio, each its own control showing its current value.
              They sit left of the gear because they are reached far more often
              than source or subtitles, and `menu` stays a single value so
              opening one closes the others - two open popups overlapping in a
              390px row is what the one-sheet design was avoiding. */}
          {/* A pick closes the menu: the button's badge and the tick are the
              confirmation, and an open list left over the picture after a
              choice read as "nothing happened". */}
          <QualityMenu levels={levels} currentLevel={currentLevel} autoLevel={autoLevel}
                       onPickLevel={(i) => { openMenu(null); onPickLevel?.(i); }}
                       open={menu === 'quality'} onTouch={touchSheet}
                       onToggle={() => openMenu(menu === 'quality' ? back : 'quality')} />

          {/* Picture, as its own control. Answers "whose video"; AudioMenu
              answers "which language". Two lists rather than one list of
              fused combinations - see web/lib/player/trackChoices.js. */}
          <VideoMenu choices={serverList} currentId={currentSourceId}
                     currentSource={currentSource}
                     onPick={(c) => {
                       openMenu(null);
                       if (c?.embed) onPickEmbed?.(c);
                       else if (c?.source) onPickSource?.(c.source);
                     }}
                     open={menu === 'video'} onTouch={touchSheet}
                     onToggle={() => openMenu(menu === 'video' ? back : 'video')} />

          {/* One Audio button regardless of how the provider ships languages.
              A multi-track file switches in place; a provider that ships one
              stream PER language (Salaar: 13 streams = 6 languages x 2
              qualities) switches source behind the same control, so the
              viewer never has to know the difference. */}
          <AudioMenu audioTracks={mergedAudio} currentAudio={audioMenu.current}
                     onPickAudio={(id) => {
                       openMenu(null);
                       // An in-file track switch is the cheap path, but the
                       // menu also lists languages from OTHER sources, whose
                       // ids are not hls track indices. pickAudio returns
                       // false when it refuses one, and we fall through to
                       // the source-switch / pairing paths below rather than
                       // leaving the label switched and the audio unchanged.
                       if (audioMenu.kind === 'muxed' && onPickAudio?.(id) !== false) return;
                       // onPickSource takes the SOURCE OBJECT, not an id:
                       // switchSource bails on `!src?.masterUrl`, so passing an
                       // id here would silently do nothing. It preserves the
                       // playback position (resumeAt), so switching language
                       // mid-film resumes where the viewer was.
                       const next = sources.find((sc) => sc.id === id);
                       if (next) {
                         // A per-language sibling source. Name the language so
                         // the choice outlives a later server switch, the same
                         // way an in-file pick and a pairing do.
                         const named = audioMenu.options.find((o) => o.id === id);
                         onPickSource?.(next, named?.name || null);
                         return;
                       }
                       // Not a sibling source: a language living in ANOTHER
                       // provider, to be paired with the picture already
                       // playing. pairingFor says whether that is possible or
                       // whether it has to substitute the picture instead.
                       const choice = audioList.find((c) => c.id === id);
                       if (!choice) return;
                       // The PICTURE that is playing. During a pairing the id
                       // is `pair-<video>-<audio>`, which is no row, so a
                       // plain id lookup found nothing and the pick silently
                       // did nothing; videoIdOf maps it to the video half.
                       const playingVideo = videoIdOf(currentSourceId, sources);
                       const video = videoList.find((c) => c.id === playingVideo);
                       const plan = pairingFor(video, choice);
                       onPickPair?.(plan);
                     }}
                     sync={audioSync}
                     open={menu === 'audio'} onTouch={touchSheet}
                     onToggle={() => openMenu(menu === 'audio' ? back : 'audio')} />

    </>
  );

  const pct = state.dur ? (state.t / state.dur) * 100 : 0;
  const bufPct = state.dur ? (state.buffered / state.dur) * 100 : 0;

  return (
    <div className={`pctl ${visible || scrubbing ? 'show' : ''}`} data-focus-group=""
         ref={rootRef}
         onFocusCapture={(e) => {
           // Remember the control a menu was opened from, so closing it can
           // put focus back there (see the focus effect above).
           if (!e.target.closest?.('[role="menu"]')) opener.current = e.target;
         }}
         onClick={() => openMenu(null)}>
      <div className="pctl-top">
        <div className="pctl-title">
          <b>{title}</b>
          {subtitle && <span>{subtitle}</span>}
        </div>
        <button className="icon-btn focusable" data-focus="" aria-label="Close player" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="pctl-mid"
           onClick={(e) => { e.stopPropagation(); onSurfaceTap(e); }}>
        {tapHint && (
          <span className={`tap-hint ${tapHint}`} aria-hidden="true">
            <Icon name={tapHint === 'back' ? 'seek-back' : 'seek-fwd'} size={30} />
          </span>
        )}
        {/* No centre play/pause: the bottom-left button is the single place
            playback is toggled, and a second control in the middle of the
            picture competes with the double-tap seek zones. */}
      </div>

      <div className="pctl-bottom" onClick={e => e.stopPropagation()}>
        {/* Pointer-driven, not an <input type="range">.
            A range input quantises to its step, so a click landed on the
            nearest 1/1000th rather than exactly where the finger went down, and
            it fired onChange for every intermediate value - seeking the decoder
            dozens of times through one drag, which is what felt unsmooth. It
            also carries the browser's own focus ring, which is the outline.

            Pointer events give the exact fraction, and the seek happens once
            on release; during the drag only `drag` moves, so the bar tracks
            the finger at display rate with no decoder work at all. */}
        {/* data-focus makes the bar a D-pad STOP. Without it a remote could
            never land on it - lib/dpad.js only walks [data-focus] - so
            onScrubKey below was unreachable on a TV and the only way to seek
            was the +-10s buttons. Focused, left/right scrub; up/down leave for
            the rows above and below, which is the standard 10-foot pattern. */}
        <div className="pctl-scrub" ref={scrubRef} role="slider" tabIndex={0}
             data-focus=""
             data-scrubbing={drag !== null ? '' : undefined}
             aria-label="Seek" aria-valuemin={0} aria-valuemax={100}
             aria-valuenow={Math.round(drag ?? pct)}
             aria-valuetext={fmt(((drag ?? pct) / 100) * (state.dur || 0))}
             onPointerDown={onScrubDown}
             onKeyDown={onScrubKey}>
          <div className="pctl-track">
            <span className="pctl-buf" style={{ width: `${bufPct}%` }} />
            <span className="pctl-played" style={{ width: `${drag ?? pct}%` }} />
            <span className="pctl-knob" style={{ left: `${drag ?? pct}%` }} />
          </div>
        </div>

        <div className="pctl-row">
          <button className="icon-btn focusable" data-focus="" data-primary="" aria-label={state.playing ? 'Pause' : 'Play'} onClick={toggle}>
            <Icon name={state.playing ? 'pause' : 'play'} size={17} />
          </button>
          {/* On a phone these are replaced by double-tap on the video, which
              is the convention and frees the row for what cannot be gestured. */}
          {!compact && (
            <>
              <button className="icon-btn focusable" data-focus="" aria-label="Back 10 seconds" onClick={() => nudge(-10)}>
                <Icon name="seek-back" size={17} />
              </button>
              <button className="icon-btn focusable" data-focus="" aria-label="Forward 10 seconds" onClick={() => nudge(10)}>
                <Icon name="seek-fwd" size={17} />
              </button>
            </>
          )}

          <button className="icon-btn focusable" data-focus="" aria-label={state.muted ? 'Unmute' : 'Mute'}
                  onClick={() => { const el = v(); if (el) el.muted = !el.muted; }}>
            <Icon name={state.muted || state.vol === 0 ? 'mute' : 'volume'} size={17} />
          </button>
          <input type="range" min="0" max="100" value={Math.round((state.muted ? 0 : state.vol) * 100)}
                 aria-label="Volume" className="pctl-vol"
                 onChange={e => { const el = v(); if (el) { el.volume = Number(e.target.value) / 100; el.muted = false; } }} />

          <span className="pctl-time">{fmt(state.t)} <em>/</em> {fmt(state.dur)}</span>

          <span className="pctl-spacer" />

          {!compact && picks}

          <div className="pmenu-wrap pctl-picks">
            <button className="icon-btn focusable" data-focus="" aria-label="Settings"
                    title="Source and subtitle settings"
                    aria-haspopup="menu" aria-expanded={sheetOpen}
                    onClick={e => { e.stopPropagation(); openMenu(sheetOpen ? null : 'all'); }}>
              <Icon name="settings" size={18} />
            </button>
            {sheetOpen && (
              <div className="pmenu pmenu-sheet" role="menu" data-focus-group=""
                   onClick={e => { e.stopPropagation(); touchSheet(); }}
                   onPointerDown={touchSheet}
                   onKeyDown={touchSheet}
                   onScroll={touchSheet}
                   onWheel={touchSheet}>
                <SettingsSheet
                  subs={subs} currentSub={currentSub} onPickSub={onPickSub}
                  subLoading={subLoading}
                  subPrefs={subPrefs} onSubPrefs={onSubPrefs}
                  onClose={() => openMenu(null)}
                  picks={compact ? picks : null}
                />
              </div>
            )}
          </div>

          {/* Picture fit. Next to fullscreen because they are the same
              question - how the frame meets the screen. */}
          {!compact && (
          <button className="icon-btn focusable" data-focus=""
                  aria-label={`Picture fit: ${fit === 'contain' ? 'whole frame'
                    : fit === 'cover' ? 'fill and crop' : 'stretch'}`}
                  onClick={() => onCycleFit?.()}>
            <Icon name={fit === 'contain' ? 'fit-contain'
                      : fit === 'cover' ? 'fit-cover' : 'fit-fill'} size={17} />
          </button>
          )}

          <button className="icon-btn focusable" data-focus="" aria-label="Fullscreen"
                  onClick={() => {
                    const el = v()?.parentElement;
                    if (document.fullscreenElement) document.exitFullscreen?.();
                    else el?.requestFullscreen?.().catch(() => {});
                  }}>
            <Icon name="fullscreen" size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
