'use client';
import Icon from '../Icon';
import MenuRow from './MenuRow';

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
  choices = [], currentId, onPick,
  open, onToggle, onTouch,
}) {
  if (!choices.length) return null;

  const active = choices.find((c) => c.id === currentId) || choices[0];
  // `label` is the provider name; `quality` is the best this server offers.
  const badge = active?.label || active?.provider || 'Server';
  // Name and ceiling, nothing else.
  //
  // This used to append `describe(c.source)` - the language list - so a row
  // read "up to 720p · Hindi, Kannada, Malayalam +2". At the menu's width that
  // wrapped to three lines and overlapped the provider name sitting beside it,
  // which is the bug in the screenshot: the rows were taller than their own
  // labels and "CastleTV" was struck through by its own metadata.
  //
  // The languages were there to tell several rows from the same provider apart
  // (CastleTV returns 3 on 1408162, 5 on Devara). That job moves to a plain
  // ordinal below, which costs one short word instead of a wrapped paragraph -
  // and the Audio control already names the language that is actually playing,
  // so the list was repeating information the viewer can read one button over.
  const maxOf = (c) => (
    c.quality && c.quality !== 'Auto' ? `up to ${c.quality}` : 'Auto quality'
  );

  // Number every repeated PROVIDER, once, across the whole list.
  //
  // Keying the counter by `provider|quality` numbered each ceiling as its own
  // group, so a provider with rows at two ceilings restarted at 1 and the menu
  // showed "CastleTV 1" twice - once at 720p and again at 480p. Measured
  // 2026-09-22 on movie/912649: CastleTV 1-4 at 720p then CastleTV 1-4 again
  // at 480p, eight rows with four labels between them. The ordinal exists to
  // tell rows apart, so it has to be unique across the rows the viewer can
  // actually see, not within a subgroup they cannot.
  const seen = new Map();
  for (const c of choices) {
    const name = c.label || c.provider || 'Server';
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  const shown = new Map();
  const labelOf = (c) => {
    const name = c.label || c.provider || 'Server';
    if ((seen.get(name) || 0) < 2) return name;
    const n = (shown.get(name) || 0) + 1;
    shown.set(name, n);
    return `${name} ${n}`;
  };
  // Tick exactly ONE row, by POSITION rather than by id equality.
  //
  // `selected={c.id === currentId}` ticked every row whose id matched, and the
  // sources list can carry the same id twice: useResolve merges late-arriving
  // providers by PROVIDER NAME (lib/player/useResolve.js:237, :306) while ids
  // are minted by array index in lib/backend.js toSource(), so a merge that
  // reorders or re-adds a provider can mint a duplicate. Two ticks in one
  // radio group is also invalid ARIA. Resolving to a single index makes a
  // second tick unrepresentable, whatever the data does.
  //
  // -1 (no tick) is correct and deliberate when a PAIR is playing: pickPair
  // sets the id to `pair-<video>-<audio>`, which is not any row in this list.
  const selectedIndex = choices.findIndex((c) => c.id === currentId);
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
            <MenuRow key={c.id ?? i} label={labelOf(c)} meta={maxOf(c)}
                     selected={i === selectedIndex}
                     onClick={() => onPick?.(c)} />
          ))}
        </div>
      )}
    </div>
  );
}
