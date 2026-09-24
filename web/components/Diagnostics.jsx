'use client';
import { useEffect, useState } from 'react';

/**
 * The log lives OUTSIDE React, and the listeners attach once.
 *
 * Inside an effect they were torn down by Strict Mode's double-mount and by
 * the remount on navigating into the player - so the panel rendered but never
 * showed an event, which reads exactly like a broken diagnostic. A module-level
 * buffer cannot be unmounted.
 */
const LOG = [];
let attached = false;
const subscribers = new Set();

function push(line) {
  LOG.push(line);
  if (LOG.length > 8) LOG.shift();
  subscribers.forEach(fn => fn([...LOG]));
}

function attach() {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  window.addEventListener('error', (e) => push('ERR ' + (e.message || e.type)));
  window.addEventListener('unhandledrejection',
    (e) => push('REJ ' + String(e.reason?.message || e.reason).slice(0, 90)));
  // What the remote actually sends: Fire TV's OK may not be the `Enter` our
  // handlers test for.
  window.addEventListener('keydown', (e) => push(
    `key=${e.key} code=${e.code} which=${e.keyCode} on=`
    + (document.activeElement?.getAttribute?.('aria-label')
       || document.activeElement?.tagName)), true);
  window.addEventListener('click', (e) => push(
    `click ${e.target?.tagName}.${String(e.target?.className).slice(0, 24)}`), true);
}

/**
 * On-screen diagnostics for a device we cannot attach a debugger to.
 *
 * Fire TV's Silk has no usable devtools and Playwright cannot emulate its
 * Chrome 70 engine - a Silk user-agent on a modern Chrome reported everything
 * healthy while the real device failed, so three rounds of reasoning produced
 * no answer. This shows the facts instead.
 *
 * Enabled with ?debug=1 and remembered, so it survives the navigation into the
 * player. ?debug=0 clears it.
 */
export default function Diagnostics() {
  const [on, setOn] = useState(false);
  const [lines, setLines] = useState([]);

  useEffect(() => {
    let enabled = false;
    try {
      const q = new URLSearchParams(window.location.search).get('debug');
      if (q === '1' || q === '0') {
        localStorage.setItem('chitram.debug', q);
        enabled = q === '1';
      } else {
        enabled = localStorage.getItem('chitram.debug') === '1';
      }
    } catch { /* private mode */ }
    if (!enabled) return;
    setOn(true);
    attach();
    setLines([...LOG]);
    subscribers.add(setLines);
    return () => subscribers.delete(setLines);
  }, []);

  if (!on) return null;

  const support = {
    ':has()': cssOk('selector(:has(*))'),
    ResizeObserver: typeof ResizeObserver === 'function',
    'aspect-ratio': cssOk('(aspect-ratio: 1/1)'),
    gap: cssOk('(gap: 1px)'),
    fullscreen: typeof document.documentElement.requestFullscreen === 'function',
  };

  return (
    <div style={{
      position: 'fixed', left: 0, bottom: 0, zIndex: 9999, maxWidth: '100%',
      background: 'rgba(0,0,0,.85)', color: '#0f0', font: '11px/1.35 monospace',
      padding: '6px 8px', pointerEvents: 'none', whiteSpace: 'pre-wrap',
    }}>
      {`UA ${navigator.userAgent.slice(0, 96)}
tv=${document.documentElement.dataset.tv || 'no'}  focusables=${document.querySelectorAll('[data-focus]').length}
support ${Object.entries(support).map(([k, v]) => `${k}:${v ? 'y' : 'N'}`).join(' ')}
${lines.join('\n')}`}
    </div>
  );
}

function cssOk(q) {
  try { return typeof CSS !== 'undefined' && CSS.supports && CSS.supports(q); }
  catch { return false; }
}
