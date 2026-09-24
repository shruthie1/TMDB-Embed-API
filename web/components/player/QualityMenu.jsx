'use client';
import Icon from '../Icon';
import MenuRow from './MenuRow';

/**
 * Video quality, as its own control.
 *
 * It used to be the second group inside the settings gear, which meant three
 * taps to change resolution and no way to see the current one without opening
 * the sheet. Quality is the single most adjusted setting on a weak connection,
 * so it gets its own button, and the button SHOWS the active rung.
 *
 * The trigger renders nothing when the ladder is unknown. `levels` is [] for
 * a stream whose manifest we never parsed, and a one-entry menu built from a
 * guess is worse than no menu: it invites a tap that cannot change anything.
 */
export default function QualityMenu({
  levels = [], currentLevel = -1, autoLevel, onPickLevel,
  open, onToggle, onTouch,
}) {
  if (!levels.length) return null;

  // What the button reads. On Auto we show the rung hls.js actually settled
  // on, because "Auto" alone hides the answer to the only question being
  // asked - am I watching 1080p or 360p right now?
  const active = levels.find(l => l.index === currentLevel);
  const badge = currentLevel === -1 ? (autoLevel || 'Auto') : (active?.label || 'Auto');

  return (
    <div className="pmenu-wrap">
      <button className="icon-btn pctl-pick-btn focusable" data-focus=""
              aria-label={`Video quality: ${currentLevel === -1 ? `Auto${autoLevel ? `, currently ${autoLevel}` : ''}` : badge}`}
              title="Video quality"
              aria-haspopup="menu" aria-expanded={Boolean(open)}
              onClick={e => { e.stopPropagation(); onToggle?.(); }}>
        <Icon name="quality" size={17} />
        <span className="pctl-pick-badge">{badge}</span>
      </button>

      {open && (
        <div className="pmenu pmenu-pick" role="menu" data-focus-group=""
             onClick={e => { e.stopPropagation(); onTouch?.(); }}
             onPointerDown={onTouch} onKeyDown={onTouch}
             onScroll={onTouch} onWheel={onTouch}>
          <p className="pmenu-label">Quality</p>
          {/* Auto stays first and stays selectable: someone who pinned 480p on
              a bad line needs an obvious way back to adaptive. */}
          <MenuRow label="Auto" meta={autoLevel} selected={currentLevel === -1}
                   onClick={() => onPickLevel?.(-1)} />
          {levels.map(l => (
            <MenuRow key={l.index} label={l.label} meta={l.bitrate}
                     selected={currentLevel === l.index}
                     onClick={() => onPickLevel?.(l.index)} />
          ))}
        </div>
      )}
    </div>
  );
}
