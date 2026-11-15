'use client';
import Icon from '../Icon';
import MenuRow from './MenuRow';
import { videoIdOf, videoLabels } from '../../lib/player/trackChoices';

/**
 * Server, as its own control, beside Audio.
 *
 * Until 2026-09-22 the player offered ONE list containing pre-fused rows: a
 * "showsst+CastleTV" entry sat above the plain streams, so choosing a picture
 * and choosing a language were the same act. Every extra language multiplied
 * the list - V pictures x A languages - and the viewer had to read provider
 * names to work out which row meant what.
 *
 * Two controls is the same information without the multiplication: V + A rows
 * instead of V x A. This one answers "whose picture", AudioMenu answers "which
 * language", and the backend pairs whatever the two of them land on.
 *
 * Shows the PROVIDER, with the best quality that provider supports as the
 * secondary line. Resolution alone is not the choice being made here: video
 * quality already has its own Auto/ladder control, so a list of bare
 * resolutions duplicated it and hid the thing that actually differs between
 * rows - which server is serving. Asked for 2026-09-22.
 */
export default function VideoMenu({
  choices = [], currentId, currentSource = null, onPick,
  open, onToggle, onTouch,
}) {
  if (!choices.length) return null;

  // Name and ceiling, nothing else. The ceiling used to carry the language
  // list too, which wrapped to three lines at this width and struck the
  // provider name through; rows from one provider are told apart by an
  // ordinal instead (videoLabels), and the Audio button already names the
  // language that is playing.
  const maxOf = (c) => (
    c.quality && c.quality !== 'Auto' ? `up to ${c.quality}` : 'Auto quality'
  );
  const labels = videoLabels(choices);

  // Tick exactly ONE row, by POSITION rather than by id equality: ids are
  // minted by array index in lib/backend.js toSource(), so a merge can carry
  // the same id twice, and two ticks in one radio group is invalid ARIA.
  //
  // videoIdOf maps a PAIR (`pair-<video>-<audio>`) to its video half. Comparing
  // the pair id directly matched no row, so a paired server - the normal
  // result of picking a server while Telugu is standing - showed no tick and
  // the button fell back to the first row's name.
  const activeId = videoIdOf(currentId, choices);
  const selectedIndex = activeId == null ? -1 : choices.findIndex((c) => c.id === activeId);
  // The button names the exact row ("CastleTV 2"), the same text as the
  // ticked row. With no row matched it says what useResolve says is playing,
  // never the first row's name, which claimed a server that was not on.
  const badge = selectedIndex >= 0
    ? labels[selectedIndex]
    : (currentSource || labels[0]);
  const only = choices.length === 1;

  return (
    <div className="pmenu-wrap">
      <button className="icon-btn pctl-pick-btn focusable" data-focus=""
              aria-label={only ? `Server: ${badge}` : `Server: ${badge}. ${choices.length} available`}
              title={only ? `Server: ${badge}` : 'Server'}
              aria-haspopup={only ? undefined : 'menu'}
              aria-expanded={only ? undefined : Boolean(open)}
              aria-disabled={only || undefined}
              onClick={(e) => { e.stopPropagation(); if (!only) onToggle?.(); }}>
        <Icon name="server" size={17} />
        <span className="pctl-pick-label">Server</span>
        <span className="pctl-pick-badge">{badge}</span>
        <Icon name="chevron" size={16} className="pctl-pick-chev" />
      </button>

      {open && !only && (
        <div className="pmenu pmenu-pick" role="menu" data-focus-group=""
             onClick={(e) => { e.stopPropagation(); onTouch?.(); }}
             onPointerDown={onTouch} onKeyDown={onTouch}
             onScroll={onTouch} onWheel={onTouch}>
          <p className="pmenu-label">Servers</p>
          {choices.map((c, i) => (
            <MenuRow key={c.id ?? i} label={labels[i]} meta={maxOf(c)}
                     selected={i === selectedIndex}
                     onClick={() => onPick?.(c)} />
          ))}
        </div>
      )}
    </div>
  );
}
