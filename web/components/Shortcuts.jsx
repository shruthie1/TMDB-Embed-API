'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Icon from './Icon';

const MAP = [
  { id: 'search', keys: ['/'], label: 'Search' },
  { id: 'home', keys: ['g', 'h'], label: 'Go home' },
  { id: 'browse', keys: ['g', 'b'], label: 'Go to browse' },
  { id: 'list', keys: ['g', 'l'], label: 'Go to my list' },
  { id: 'help', keys: ['?'], label: 'This help' },
  { id: 'back', keys: ['Esc'], label: 'Back / close' },
];

const PLAYER = [
  { id: 'play', keys: ['Space', 'k'], label: 'Play / pause' },
  { id: 'seek-arrows', keys: ['←', '→'], label: 'Seek ∓10s' },
  { id: 'seek-jl', keys: ['j', 'l'], label: 'Seek ∓10s' },
  { id: 'volume', keys: ['↑', '↓'], label: 'Volume' },
  { id: 'fullscreen', keys: ['f'], label: 'Fullscreen' },
  { id: 'mute', keys: ['m'], label: 'Mute' },
  { id: 'subs', keys: ['c'], label: 'Subtitles' },
  { id: 'seek-pct', keys: ['0-9'], label: 'Seek to 0–90%' },
];

/** Ignore keys while typing, or the search box becomes unusable. */
function isTyping(el) {
  return el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

export default function Shortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let pendingG = null;

    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(document.activeElement)) {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      // The player owns its own keys while it is open.
      if (document.querySelector('.player')) return;

      if (e.key === '?') { e.preventDefault(); setOpen(v => !v); return; }
      if (e.key === 'Escape') { setOpen(false); return; }

      if (pendingG) {
        clearTimeout(pendingG.timer);
        pendingG = null;
        const go = { h: '/', b: '/browse', l: '/list', s: '/search' }[e.key];
        if (go) { e.preventDefault(); router.push(go); return; }
      }
      if (e.key === 'g') {
        pendingG = { timer: setTimeout(() => { pendingG = null; }, 900) };
        return;
      }
      if (e.key === '/' || e.key === 's') { e.preventDefault(); router.push('/search'); }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  if (!open) return null;

  return (
    <div className="sc-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
         onClick={() => setOpen(false)}>
      <div className="sc-panel" onClick={e => e.stopPropagation()}>
        <div className="sc-head">
          <h2 className="row-label">Keyboard shortcuts</h2>
          <button className="icon-btn focusable" data-focus="" aria-label="Close" onClick={() => setOpen(false)}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="sc-cols">
          <div>
            <p className="flabel">Anywhere</p>
            {MAP.map(s => (
              <div className="sc-row" key={s.id}>
                <span className="sc-keys">{s.keys.map(k => <kbd key={`${s.id}-${k}`}>{k}</kbd>)}</span>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
          <div>
            <p className="flabel">While playing</p>
            {PLAYER.map(s => (
              <div className="sc-row" key={s.id}>
                <span className="sc-keys">{s.keys.map(k => <kbd key={`${s.id}-${k}`}>{k}</kbd>)}</span>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
