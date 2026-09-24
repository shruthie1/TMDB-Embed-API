'use client';
import { useCallback, useRef, useState } from 'react';

// Seconds at each end. Beyond a couple of seconds the two halves are not the
// same cut of the film and no slider will save them, so a wider range would
// only make the useful middle harder to hit.
export const SYNC_MIN = -3;
export const SYNC_MAX = 3;
const STEP = 0.05;   // 50ms - just under one video frame at 24fps

const clamp = (n) => Math.min(SYNC_MAX, Math.max(SYNC_MIN, n));
const snap = (n) => Math.round(n / STEP) * STEP;

export function fmtOffset(s) {
    if (Math.abs(s) < 0.025) return 'In sync';
    return `${s > 0 ? 'Audio later ' : 'Audio earlier '}${Math.abs(s).toFixed(2)}s`;
}

/**
 * Audio timing, as a bar rather than a pair of nudge buttons.
 *
 * Asked for on 2026-09-22: stepping in fixed jumps means hunting for the right
 * value, while a bar lets the viewer slide until the lips line up and stop
 * there. It scrubs like the seek bar - drag to preview, commit on release -
 * because previewing is cheap in the browser and committing may cost a stream
 * reload (see lib/player/useAudioSync.js).
 */
export default function SyncBar({ value = 0, onPreview, onCommit, onTouch }) {
    const trackRef = useRef(null);
    const [drag, setDrag] = useState(null);
    const shown = drag ?? value;
    const pct = ((shown - SYNC_MIN) / (SYNC_MAX - SYNC_MIN)) * 100;

    const valueAt = useCallback((clientX) => {
        const r = trackRef.current?.getBoundingClientRect();
        if (!r || !r.width) return 0;
        const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
        return snap(SYNC_MIN + ratio * (SYNC_MAX - SYNC_MIN));
    }, []);

    const onPointerDown = useCallback((e) => {
        e.stopPropagation();
        onTouch?.();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const v = valueAt(e.clientX);
        setDrag(v);
        onPreview?.(v);
    }, [valueAt, onPreview, onTouch]);

    const onPointerMove = useCallback((e) => {
        if (drag === null) return;
        const v = valueAt(e.clientX);
        setDrag(v);
        onPreview?.(v);
    }, [drag, valueAt, onPreview]);

    const endDrag = useCallback((e) => {
        if (drag === null) return;
        e?.stopPropagation?.();
        onTouch?.();
        // Commit ONCE, on release. Committing per move would fire a re-pair on
        // every pixel of the drag.
        onCommit?.(drag);
        setDrag(null);
    }, [drag, onCommit, onTouch]);

    // Keyboard is the accessible path and also the precise one: a 50ms step is
    // hard to hit with a pointer on a short bar.
    const onKeyDown = useCallback((e) => {
        const d = e.key === 'ArrowRight' ? STEP
            : e.key === 'ArrowLeft' ? -STEP
                : e.key === 'PageUp' ? STEP * 10
                    : e.key === 'PageDown' ? -STEP * 10
                        : e.key === 'Home' ? 'zero' : null;
        if (d === null) return;
        e.preventDefault();
        e.stopPropagation();
        onTouch?.();
        const next = d === 'zero' ? 0 : clamp(snap(value + d));
        onPreview?.(next);
        onCommit?.(next);
    }, [value, onPreview, onCommit, onTouch]);

    return (
        <div className="sync-bar-wrap">
            <div className="sync-bar-head">
                <span className="sub-set-k">Audio timing</span>
                <span className="sync-bar-val" aria-live="polite">{fmtOffset(shown)}</span>
            </div>
            <div ref={trackRef} className="sync-bar focusable" data-focus=""
                 role="slider" tabIndex={0}
                 aria-label="Audio timing"
                 aria-valuemin={SYNC_MIN} aria-valuemax={SYNC_MAX}
                 aria-valuenow={Number(shown.toFixed(2))}
                 aria-valuetext={fmtOffset(shown)}
                 onPointerDown={onPointerDown}
                 onPointerMove={onPointerMove}
                 onPointerUp={endDrag}
                 onPointerCancel={endDrag}
                 onKeyDown={onKeyDown}>
                <div className="sync-bar-track">
                    {/* The centre mark is the whole point of the control: it
                        shows where "no shift" is, so the viewer can always get
                        back to it. */}
                    <span className="sync-bar-zero" />
                    <span className="sync-bar-fill"
                          style={{ left: `${Math.min(50, pct)}%`, width: `${Math.abs(pct - 50)}%` }} />
                    <span className="sync-bar-knob" style={{ left: `${pct}%` }} />
                </div>
            </div>
            {Math.abs(shown) >= 0.025 && (
                <button className="sync-bar-reset focusable" data-focus=""
                        onClick={(e) => { e.stopPropagation(); onTouch?.(); onPreview?.(0); onCommit?.(0); }}>
                    Reset to in sync
                </button>
            )}
        </div>
    );
}
