'use strict';
// File-tag language probes never hold an answer (owner 2026-11-24: "we cannot
// have that delay"). A provider returns its rows at once with what the probe
// caches already know. A cold probe runs here, in the background. When it
// changes a row, the row's new normalised form is kept by url (an overlay),
// apiServer applies the overlay to that provider's rows on the next read
// (provider cache or fresh run), and the title's whole-answer memo is dropped
// so the ?full=1 follow-up or the next request carries the languages.
//
// Measured before (VM, 2026-11-24): ShowsSt 1.8-2.2 s/hour average before the
// blocking ffprobe, 3.0 s average and 5.5 s max after; J2 1234139 ?full=1 took
// 7.5 s with ShowsSt at 5.2 s.

const { EventEmitter } = require('events');
const { createTtlCache } = require('../runtime/ttlCache');
const { normaliseStream } = require('../../utils/streamSchema');

const OVERLAY_TTL_MS = 30 * 60 * 1000; // same as the probe caches
const BACKGROUND_CAP_MS = Number(process.env.LANG_LATER_CAP_MS) || 15000;

const overlay = createTtlCache({ ttlMs: OVERLAY_TTL_MS, maxEntries: 5000 });
const events = new EventEmitter();
const pending = new Set();
// tmdbId -> last time a probe relabelled rows of it (bounded like the overlay).
const landed = createTtlCache({ ttlMs: OVERLAY_TTL_MS, maxEntries: 5000 });

// Only the language fields move: the rest of the cached row (url, headers,
// quality, levels) stays as the provider run produced it.
const FIELDS = ['languages', 'language', 'name', 'audio', 'languageSource', 'selectableAudio'];

/**
 * Run `work` in the background. `work` resolves to the raw rows it relabelled
 * in place (same objects the provider returned). Never throws, never awaited
 * by the caller. Returns the background promise (tests await it).
 */
function later(provider, tmdbId, work) {
    let timer;
    const cap = new Promise((r) => { timer = setTimeout(() => r('cap'), BACKGROUND_CAP_MS); });
    const t0 = Date.now();
    const run = Promise.resolve().then(work);
    const p = Promise.race([run, cap]).then((changed) => {
        clearTimeout(timer);
        if (changed === 'cap') {
            console.log(`[lang-later] ${provider} ${tmdbId} still probing after ${BACKGROUND_CAP_MS}ms; rows stay as sent`);
            return [];
        }
        const rows = (Array.isArray(changed) ? changed : []).filter((r) => r && r.url);
        for (const raw of rows) {
            const n = normaliseStream({ ...raw, provider: raw.provider || provider });
            if (!n) continue;
            const patch = {};
            for (const f of FIELDS) if (n[f] !== undefined) patch[f] = n[f];
            if (!n.languageSource) patch.languageSource = undefined;
            overlay.set(raw.url, patch);
        }
        console.log(`[lang-later] ${provider} ${tmdbId} probed in ${Date.now() - t0}ms: ${rows.length} row(s) relabelled`);
        if (rows.length) {
            landed.set(String(tmdbId), Date.now());
            events.emit('changed', { provider, tmdbId: String(tmdbId) });
        }
        return rows;
    }, (e) => {
        clearTimeout(timer);
        console.log(`[lang-later] ${provider} ${tmdbId} probe failed: ${e && e.message}`);
        return [];
    });
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
}

/** Rows with any landed overlay applied (new objects; cached rows are not mutated). */
function apply(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    let hit = false;
    const out = rows.map((r) => {
        const patch = r && r.url ? overlay.get(r.url) : undefined;
        if (!patch) return r;
        hit = true;
        const next = { ...r, ...patch };
        if (patch.languageSource === undefined) delete next.languageSource;
        if (next.language === undefined) delete next.language;
        return next;
    });
    if (!hit) return rows;
    for (const k of Object.keys(rows)) if (!/^\d+$/.test(k)) out[k] = rows[k]; // timedOut, upstreamError markers
    return out;
}

function onChanged(fn) { events.on('changed', fn); }

/** True when a probe relabelled rows of `tmdbId` at or after `t0` (ms). */
function landedSince(tmdbId, t0) {
    const at = landed.get(String(tmdbId));
    return at !== undefined && at >= t0;
}

/** Tests: wait for every background probe started so far. */
function settle() { return Promise.all([...pending]); }

module.exports = { later, apply, onChanged, landedSince, settle, _overlay: overlay };
