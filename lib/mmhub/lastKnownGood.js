'use strict';
// Last-known-good Telugu rows (owner go, 2026-11-24).
//
// RRR 579974: VidBolt stopped LISTING its Telugu master between 11-22 and
// 11-24 while the file itself still answered 200 on the CDN (rrr-telugu-debug.md
// section 2). So every row that carries a Telugu tag, from any provider, is
// kept here until its URL's stated expiry (lib/urlExpiry.js), or 24 h when the
// URL states none. When a later live answer has no Telugu row, the kept row is
// checked once (master + first segment, lib/media/segmentVerify.js) and served
// with `lastKnownGood: true`. Tags are the ones the row had when it was live;
// nothing here adds or changes a language. A failed check or a failed
// playback report evicts the row.

const { urlExpiresAt } = require('../urlExpiry');
const { mediaIdentityOf } = require('../../utils/store');

const NO_EXPIRY_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_PER_TITLE = 3;
const VERIFY_MS = 4000;

function isTelugu(row) {
    if (!row) return false;
    let canon;
    try { canon = require('../../utils/streamSchema').canonicalLanguage; } catch { canon = (v) => v; }
    const te = (v) => v && canon(String(v)) === 'Telugu';
    if (Array.isArray(row.languages) && row.languages.some(te)) return true;
    return Array.isArray(row.audio) && row.audio.some((a) => a && (te(a.language) || te(a.name)
        || /^(te|tel)$/i.test(String(a.languageCode || ''))));
}

const storeOf = (opts) => opts.store || require('../../utils/store').getStore();

/** Keep the Telugu rows of a live answer. Returns how many were stored. */
function remember(title, rows, opts = {}) {
    const now = opts.now ?? Date.now();
    const s = storeOf(opts);
    const skip = opts.skipPrefix ? String(opts.skipPrefix) : null;
    let n = 0;
    const seen = new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
        if (n >= MAX_PER_TITLE) break;
        if (!r || !r.url || r.lastKnownGood || !isTelugu(r)) continue;
        if (r.byteCheck && r.byteCheck.ok === false) continue;
        if (skip && String(r.url).startsWith(skip)) continue;
        const stated = urlExpiresAt(r.url, now);
        if (stated !== null && stated <= now) continue;
        const id = mediaIdentityOf(r.url);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const { byteCheck, ...row } = r;
        try {
            s.lkgPut({ ...title, provider: r.provider || '', mediaIdentity: id, row,
                expiresAt: stated ?? now + NO_EXPIRY_KEEP_MS, storedAt: now });
            n++;
        } catch (e) {
            console.warn(`[lkg] store failed: ${e.message}`);
            return n;
        }
    }
    // Keep at most MAX_PER_TITLE: newest first, the rest dropped.
    try {
        const all = s.lkgFor(title, now);
        for (const extra of all.slice(MAX_PER_TITLE)) s.lkgEvict(title, extra.provider, extra.mediaIdentity);
    } catch { /* read failure: the cap waits for the next write */ }
    return n;
}

async function defaultVerify(row) {
    const { verifyOne } = require('../media/segmentVerify');
    return verifyOne(row, { attemptMs: VERIFY_MS });
}

/**
 * Rows to add when `liveRows` has no Telugu row: each kept row passes one
 * check first. [] when live already has Telugu or nothing is kept.
 */
async function serveIfMissing(title, liveRows, opts = {}) {
    const live = Array.isArray(liveRows) ? liveRows : [];
    if (live.some(isTelugu)) return [];
    const now = opts.now ?? Date.now();
    const s = storeOf(opts);
    const verify = opts.verify || defaultVerify;
    let kept;
    try { kept = s.lkgFor(title, now); } catch (e) {
        console.warn(`[lkg] read failed: ${e.message}`);
        return [];
    }
    const liveIds = new Set(live.map((r) => mediaIdentityOf(r && r.url)));
    const out = [];
    for (const k of kept) {
        if (liveIds.has(k.mediaIdentity)) continue;
        let v;
        try { v = await verify(k.row); } catch (e) { v = { ok: false, reason: e.message }; }
        if (!v || !v.ok) {
            s.lkgEvict(title, k.provider, k.mediaIdentity);
            console.warn(`[lkg] evict ${k.provider} tmdbId=${title.tmdbId} reason=${String((v && v.reason) || 'check failed').slice(0, 60)}`);
            continue;
        }
        console.log(`[lkg] serve ${k.provider} tmdbId=${title.tmdbId} storedAgoMin=${Math.round((now - k.storedAt) / 60000)}`
            + ` expiresInMin=${Math.round((k.expiresAt - now) / 60000)}`);
        out.push({ ...k.row, lastKnownGood: true, lastKnownGoodAt: k.storedAt, byteCheck: v });
    }
    return out;
}

/** A failed playback report drops the reported row. Returns rows removed. */
function evictReported(r, opts = {}) {
    if (!r || !r.mediaIdentity) return 0;
    try {
        const n = storeOf(opts).lkgEvict({ tmdbId: r.tmdbId, type: r.type, season: r.season, episode: r.episode },
            r.provider, r.mediaIdentity);
        if (n) console.warn(`[lkg] evict ${String(r.provider).toLowerCase()} tmdbId=${r.tmdbId} reason=playback-report`);
        return n;
    } catch (e) {
        console.warn(`[lkg] evict failed: ${e.message}`);
        return 0;
    }
}

module.exports = { remember, serveIfMissing, evictReported, isTelugu, NO_EXPIRY_KEEP_MS, MAX_PER_TITLE };
