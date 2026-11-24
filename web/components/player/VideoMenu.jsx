'use client';
import { useState, useEffect, useRef } from 'react';
import { sourceAudioLanguages } from '../../lib/player/languageSources';
import Icon from '../Icon';
import MenuRow from './MenuRow';
import PlayerMenu from './PlayerMenu';
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
/** APK PlayerVm.streamCount: "1 stream", "N streams". */
export const streamCount = (n) => (n === 1 ? '1 stream' : `${n} streams`);

/**
 * APK netmirrorCheck: what a finished NetMirror check found, so the tap is
 * never silent. `before`/`after` are NetMirror row counts around the check.
 */
export function netmirrorNote(before, after) {
  if (!after) return 'No NetMirror streams for this title';
  return after > before ? `${after - before} added` : 'No new streams';
}

export default function VideoMenu({
  choices = [], currentId, currentSource = null, onPick,
  open, onToggle, onTouch, onCheckSources, checkingSources = false,
  provider: providerProp, onProvider,
  // "Refresh sources" (useRefreshSources): the list's first row.
  refresh = null,
}) {
  // The drilled provider can be owned by the parent (PlayerControls), so the
  // player's Back goes up one level before it closes the sheet (APK back()).
  const [ownProvider, setOwnProvider] = useState(null);
  const controlled = typeof onProvider === 'function';
  const provider = controlled ? (providerProp ?? null) : ownProvider;
  const setProvider = controlled ? onProvider : setOwnProvider;
  const [focusLabel, setFocusLabel] = useState(null);
  useEffect(() => { if (!open) { setProvider(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Result line under "Check for more streams" (APK netmirrorNote).
  const netmirrorCount = choices.filter(c => (c.source?.provider || c.label || '').toLowerCase() === 'netmirror').length;
  const checkStart = useRef(null);
  const [note, setNote] = useState(null);
  useEffect(() => {
    if (checkingSources) { checkStart.current = netmirrorCount; setNote(null); }
    else if (checkStart.current != null) { setNote(netmirrorNote(checkStart.current, netmirrorCount)); checkStart.current = null; }
  }, [checkingSources]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!choices.length) return null;

  // Name and ceiling, nothing else. The ceiling used to carry the language
  // list too, which wrapped to three lines at this width and struck the
  // provider name through; rows from one provider are told apart by an
  // ordinal instead (videoLabels), and the Audio button already names the
  // language that is playing.
  const maxOf = (c) => {
    if (c.embed) return 'Their player';
    if (c.unsupported) return 'Not supported on this device';
    const quality = c.quality && c.quality !== 'Auto' ? c.quality : 'Auto quality';
    return c.source?.incomplete ? `${quality} · More streams pending` : quality;
  };
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
  const incomplete = choices.some(c => c.source?.incomplete);
  const only = false;
  const providerName = c => c.source?.providerGroup || c.source?.provider || c.label || 'Stream';
  const groups = new Map();
  choices.forEach(c => { const name = providerName(c); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(c); });
  if (onCheckSources && ![...groups.keys()].some(k => k.toLowerCase() === 'netmirror')) groups.set('NetMirror', []);
  const isNetmirror = provider?.toLowerCase() === 'netmirror';
  const providerRows = groups.get(provider) || [];
  const goBack = () => { setFocusLabel(provider); setProvider(null); };
  const describe = rows => {
    const languages = [...new Set(rows.flatMap(c => sourceAudioLanguages(c.source)))].slice(0, 3).join(', ');
    // APK serverItems: count · up to three languages; NetMirror before a check says so.
    if (!rows.length) return 'Check streams on demand';
    return [rows.length === 1 && rows[0].embed ? maxOf(rows[0]) : streamCount(rows.length), languages, rows.some(c => c.source?.incomplete) ? 'More streams pending' : ''].filter(Boolean).join(' · ');
  };

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
        <PlayerMenu title={provider || 'Server'} icon="server" onClose={onToggle} onBack={provider ? goBack : null} focusLabel={focusLabel} onTouch={onTouch}>
          {!provider && refresh && (
            // Stays focusable through refreshing and cooldown; a press in the cooldown says when.
            <button role="menuitem" className="pmenu-item focusable" data-focus="" data-action="refresh-sources"
                    aria-busy={refresh.running || undefined} aria-disabled={refresh.state !== 'idle' ? 'true' : undefined}
                    onClick={refresh.refresh}>
              <span className="pmenu-marker" aria-hidden="true">{refresh.running ? <span className="refresh-spin" /> : <Icon name="restart" size={14} />}</span>
              <span className="pmenu-copy">
                <span className="pmenu-text">{refresh.label}</span>
                <span className="pmenu-meta" role="status" aria-live="polite">{refresh.note || 'Current playback continues'}</span>
              </span>
            </button>
          )}
          {!provider && [...groups].map(([name, rows]) => (
            <MenuRow key={name} label={name} meta={describe(rows)} dim={refresh?.running} selected={rows.some(c => choices.indexOf(c) === selectedIndex)}
              onClick={() => { if (rows.length === 1 && rows[0].embed) { if (choices.indexOf(rows[0]) === selectedIndex) onToggle?.(); else onPick?.(rows[0]); } else { setFocusLabel(null); setProvider(name); if (!rows.length && name.toLowerCase() === 'netmirror') onCheckSources?.(); } }} />
          ))}
          {provider && providerRows.map(c => {
            const i = choices.indexOf(c);
            return <MenuRow key={`${c.id}-${i}`} label={c.source?.serverLabel || labels[i]} meta={[c.source?.netmirrorCatalog, maxOf(c), c.embed ? '' : (sourceAudioLanguages(c.source).join(', ') || 'Unknown audio')].filter(Boolean).join(' · ')} selected={i === selectedIndex} dim={c.unsupported || refresh?.running}
              // APK A2: the playing row only closes the sheet.
              onClick={() => (i === selectedIndex ? onToggle?.() : onPick?.(c))} />;
          })}
          {provider && !providerRows.length && <p className="pmenu-note">No streams found in current results.</p>}
          {(incomplete || isNetmirror) && onCheckSources && (
            <button role="menuitem" className="pmenu-item focusable" data-focus=""
                    disabled={checkingSources} aria-busy={checkingSources || undefined}
                    aria-label={checkingSources ? 'Checking sources…' : 'Check for more streams'}
                    onClick={onCheckSources}>
              <span className="pmenu-marker" aria-hidden="true">{checkingSources && <span className="pmenu-spin" />}</span>
              <span className="pmenu-copy">
                <span className="pmenu-text">{checkingSources ? 'Checking sources…' : 'Check for more streams'}</span>
                <span className="pmenu-meta">{note || 'Current playback continues'}</span>
              </span>
            </button>
          )}
        </PlayerMenu>
      )}
    </div>
  );
}
