'use client';
import Icon from '../Icon';
import MenuRow from './MenuRow';
import SyncBar from './SyncBar';

/**
 * Audio language, as its own control.
 *
 * This is the reason the whole demux path exists: a CastleTV master carries
 * five muxed tracks (Hindi, Kannada, Malayalam, Tamil, Telugu) and the viewer
 * needs one of them, usually Telugu. Buried as the LAST group of the settings
 * gear it took a tap, a scroll past Source/Quality/Subtitles, and a second tap
 * - on the single most-used switch in the player.
 *
 * The trigger shows the language that is playing, so nobody has to open the
 * menu to find out whether the Telugu preference actually landed.
 *
 * Rendered for a single track too, deliberately. Knowing the stream is Hindi
 * only is real information, and hiding the control there made "no audio menu"
 * ambiguous between "one language" and "the player is broken". It is marked
 * disabled so it reads as informational rather than inviting a dead tap.
 */
export default function AudioMenu({
  audioTracks = [], currentAudio, onPickAudio,
  open, onToggle, onTouch,
  sync = null,
}) {
  if (!audioTracks.length) return null;

  // NO `|| audioTracks[0]` fallback.
  //
  // The list mixes what is PLAYING with languages that merely COULD be paired
  // in from another provider, so element 0 is frequently not this stream's
  // audio at all. Measured 2026-09-22 on 1408162: showsst reports
  // languages:[] - it ships no language metadata - yet the button read
  // "Hindi" because Hindi is CastleTV's first language and so first in the
  // merged list. Switching server appeared to "move to Hindi" when the audio
  // had not changed at all; only the label was inventing a value.
  //
  // When nothing is known to be selected, say so rather than name a language
  // this stream may not carry.
  const active = audioTracks.find(t => t.id === currentAudio) || null;
  const badge = active?.name || 'Default';
  // A lone language normally makes the button informational, but the timing
  // bar still needs somewhere to live - and a single paired language is
  // exactly the case most likely to need nudging. So the menu stays openable
  // whenever there is a sync control to show.
  const only = audioTracks.length === 1 && !sync;

  return (
    <div className="pmenu-wrap">
      <button className="icon-btn pctl-pick-btn focusable" data-focus=""
              aria-label={only ? `Audio: ${badge}` : `Audio language: ${badge}. ${audioTracks.length} available`}
              title={only ? `Audio: ${badge}` : 'Audio language'}
              aria-haspopup={only ? undefined : 'menu'}
              aria-expanded={only ? undefined : Boolean(open)}
              aria-disabled={only || undefined}
              onClick={e => { e.stopPropagation(); if (!only) onToggle?.(); }}>
        <Icon name="audio" size={17} />
        <span className="pctl-pick-badge">{badge}</span>
      </button>

      {open && !only && (
        <div className="pmenu pmenu-pick" role="menu" data-focus-group=""
             onClick={e => { e.stopPropagation(); onTouch?.(); }}
             onPointerDown={onTouch} onKeyDown={onTouch}
             onScroll={onTouch} onWheel={onTouch}>
          <p className="pmenu-label">Audio</p>
          {audioTracks.map(t => (
            <MenuRow key={t.id} label={t.name} selected={t.id === currentAudio}
                     onClick={() => onPickAudio?.(t.id)} />
          ))}
          {/* Timing lives WITH the language list: picking a dubbed track is
              what knocks lip sync out, so the fix belongs where the cause is
              rather than behind the settings gear. */}
          {/* The two halves of this pairing are the same film cut with
              different ad/intro padding, so the automatic PTS rebase - which
              only corrects the encoder baseline - cannot close the gap.
              Measured 2026-09-23 on movie/1290190: mapple 2160p runs 402s
              longer than the CastleTV reel its Telugu track comes from, and
              the probe found 0.088s. Saying so beats letting the viewer
              discover drifting audio and conclude the player is broken. */}
          {sync?.padded && (
            <p className="pmenu-note">
              These sources are cut differently{sync.deltaSeconds
                ? ` (about ${Math.round(sync.deltaSeconds / 60)} min apart)`
                : ''}. If the audio drifts, line it up below.
            </p>
          )}
          {sync && (
            <SyncBar value={sync.value} onPreview={sync.onPreview}
                     onCommit={sync.onCommit} onTouch={onTouch} />
          )}
        </div>
      )}
    </div>
  );
}
