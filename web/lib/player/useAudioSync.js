'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

// How far the browser alone can shift audio, in seconds. A DelayNode can only
// push audio LATER, never earlier, so a negative offset (audio must arrive
// sooner) cannot be done client-side at all and always goes to the server.
export const CLIENT_MAX_DELAY = 2;
// Anything under this is inaudible as lip-sync error (~1 video frame), so it
// is treated as zero rather than spending a re-pair on it.
export const NEGLIGIBLE = 0.02;

/**
 * Manual audio offset, on top of whatever the automatic PTS rebase already did.
 *
 * Two levers, because neither one covers the range on its own:
 *
 *   DelayNode      0 .. +2s   instant, no refetch, audio LATER only
 *   server re-pair  any       exact, but reloads the stream and re-buffers
 *
 * The slider drags against the first so it feels live, and commits to the
 * second only when the value lands somewhere the DelayNode cannot reach. That
 * is why `offset` (what the viewer asked for) and `applied` (what the browser
 * is currently doing) are separate: between a drag past the limit and the
 * re-pair landing, they legitimately disagree.
 *
 * Routing a media element through Web Audio is one-way - once
 * createMediaElementSource() has claimed it, its output only reaches the
 * speakers via the graph - so the graph is built lazily on the first non-zero
 * offset and then left in place, with delay 0 meaning "no shift".
 */
export default function useAudioSync(videoRef) {
    const [offset, setOffset] = useState(0);      // seconds, what was asked for
    const [applied, setApplied] = useState(0);    // seconds, what the graph does
    const ctxRef = useRef(null);
    const delayRef = useRef(null);
    const srcRef = useRef(null);

    const ensureGraph = useCallback(() => {
        const el = videoRef?.current;
        if (!el) return null;
        if (delayRef.current) return delayRef.current;
        const Ctx = typeof window !== 'undefined'
            && (window.AudioContext || window.webkitAudioContext);
        if (!Ctx) return null;
        try {
            const ctx = new Ctx();
            // A second createMediaElementSource() on the same element throws,
            // so the node is created once and reused for the element's life.
            const src = ctx.createMediaElementSource(el);
            const delay = ctx.createDelay(CLIENT_MAX_DELAY);
            delay.delayTime.value = 0;
            src.connect(delay);
            delay.connect(ctx.destination);
            ctxRef.current = ctx;
            srcRef.current = src;
            delayRef.current = delay;
            return delay;
        } catch {
            // Autoplay policy, a cross-origin element, or no Web Audio at all.
            // The server path still works, so this is a downgrade not a break.
            return null;
        }
    }, [videoRef]);

    // True when the browser absorbed the whole request, so the caller knows
    // there is nothing to send to the server.
    const applyClient = useCallback((seconds) => {
        const want = Number(seconds) || 0;
        if (Math.abs(want) < NEGLIGIBLE) {
            if (delayRef.current) delayRef.current.delayTime.value = 0;
            setApplied(0);
            return true;
        }
        // A DelayNode cannot pull audio forward.
        if (want < 0 || want > CLIENT_MAX_DELAY) return false;
        const delay = ensureGraph();
        if (!delay) return false;
        ctxRef.current?.resume?.().catch(() => {});
        delay.delayTime.value = want;
        setApplied(want);
        return true;
    }, [ensureGraph]);

    // Dragging: always try the browser so the bar feels live, but never fail -
    // a value out of client range just leaves `applied` behind until release.
    const preview = useCallback((seconds) => {
        setOffset(Number(seconds) || 0);
        applyClient(seconds);
    }, [applyClient]);

    const reset = useCallback(() => {
        setOffset(0);
        applyClient(0);
    }, [applyClient]);

    useEffect(() => () => { ctxRef.current?.close?.().catch(() => {}); }, []);

    return {
        offset, applied, setOffset, preview, applyClient, reset,
        // The caller re-pairs when the browser could not take it.
        needsServer: (s) => !(Math.abs(Number(s) || 0) < NEGLIGIBLE
            || (Number(s) > 0 && Number(s) <= CLIENT_MAX_DELAY)),
    };
}
