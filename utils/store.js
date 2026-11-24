'use strict';

// The learning layer's persistent store: one SQLite file under data/.
//
// Everything that should survive a restart or a deploy goes through here:
//   source_stats    what a real browser saw when it played a source (G1)
//   audio_evidence  which audio language a file carries, and who said so (G10)
//   provider_health breaker state and a latency EWMA per provider (G6)
//   castle_demux_job castle-demux job specs, so a restart can rebuild a job
//
// In-memory state died with every pm2 restart and every deploy, so the server
// re-learned from zero each time: a provider that never works got its full
// 20s again, a probe that already ran ran again, and a source a viewer saw
// stall was offered first again.
//
// data/ is git-ignored (data/.gitignore ignores everything but itself), so the
// DB is never committed. deploy-vm.sh copies the live dir, so data/ carries
// over a deploy. The Docker image does not copy data/: a fresh container
// starts empty and rebuilds from traffic.
//
// Backend: better-sqlite3 in WAL mode. If the native module cannot load (no
// prebuilt binary for the platform, a failed npm ci), the SAME interface runs
// over a JSON file instead, and says so loudly at startup. If the file cannot
// be written at all (read-only FS on serverless), the store keeps working in
// memory and says so loudly - the server must not crash over telemetry.
//
// Migrations are additive only: each entry in MIGRATIONS runs once, in order,
// tracked by PRAGMA user_version. Never edit or remove a shipped entry; add a
// new one.

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'learning.sqlite');

// Who said what about an audio track, and how much to believe it. A viewer
// who reports the language is wrong is authoritative: they heard it.
const SOURCE_CONFIDENCE = { viewer: 1.0, ffprobe: 0.9, manifest: 0.8, provider: 0.7 };
const AUDIO_SOURCES = Object.keys(SOURCE_CONFIDENCE);
// At or above this, an ffprobe answer on file is used instead of probing again.
const MIN_SKIP_CONFIDENCE = 0.8;

const MIGRATIONS = [
    // v1: the three learning tables.
    `create table if not exists source_stats (
        tmdb_id integer not null,
        type text not null,
        season integer not null default 0,
        episode integer not null default 0,
        provider text not null,
        media_identity text not null default '',
        played_ok_at integer,
        play_failed_at integer,
        play_fail_reason text,
        play_fails integer not null default 0,
        startup_ms integer,
        wait_ms integer,
        stall_count integer,
        stall_ms integer,
        recovery_count integer,
        play_device text,
        play_connection text,
        audio_lang text,
        updated_at integer not null,
        primary key (tmdb_id, type, season, episode, provider, media_identity)
     );
     create table if not exists audio_evidence (
        id integer primary key autoincrement,
        tmdb_id integer,
        type text,
        s integer not null default 0,
        e integer not null default 0,
        provider text not null default '',
        media_identity text not null,
        lang text not null default '',
        source text not null check (source in ('manifest','ffprobe','provider','viewer')),
        confidence real not null,
        refuted integer not null default 0,
        detail text,
        at integer not null,
        unique (media_identity, provider, source, lang)
     );
     create index if not exists audio_evidence_identity on audio_evidence (media_identity);
     create table if not exists provider_health (
        provider text primary key,
        attempts integer not null default 0,
        successes integer not null default 0,
        ema_latency_ms integer,
        consecutive_misses integer not null default 0,
        tripped_until integer,
        trips integer not null default 0,
        last_miss_title text,
        last_ok_at integer,
        updated_at integer not null
     );`,
    // v2: castle-demux job specs. The jobs live in a Map, and every API
    // restart (every deploy) emptied it, so a TV mid-film got 404 on its next
    // playlist or segment. The spec is persisted so a miss can rebuild the job.
    `create table if not exists castle_demux_job (
        id text primary key,
        spec text not null,
        expires_at integer not null,
        updated_at integer not null
     );
     create index if not exists castle_demux_job_expires on castle_demux_job (expires_at);`,
    // v3: provider canary state (provider self-heal Task 7, lib/selfheal/canary.js).
    // One row per provider: last canary outcome, its heal kind, when it runs next.
    `create table if not exists provider_canary (
        provider text primary key,
        state text,
        kind text,
        last_run_at integer,
        last_ok_at integer,
        next_due_at integer,
        last_error text,
        telugu_ok integer,
        heal_how text,
        heal_at integer,
        runs integer not null default 0,
        fails integer not null default 0
     );`,
    // v4: last-known-good Telugu rows (lib/mmhub/lastKnownGood.js). One row per
    // title + provider + media; `row` is the stream JSON as served, tags kept.
    `create table if not exists last_known_good (
        tmdb_id integer not null,
        type text not null,
        season integer not null default 0,
        episode integer not null default 0,
        provider text not null,
        media_identity text not null,
        row text not null,
        expires_at integer not null,
        stored_at integer not null,
        primary key (tmdb_id, type, season, episode, provider, media_identity)
     );
     create index if not exists last_known_good_expires on last_known_good (expires_at);`,
];

// ---- input shaping -------------------------------------------------------

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
const int0 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
// The web says 'tv', the Express route says 'series'. One key for both.
const normType = (t) => (t === 'tv' || t === 'series' ? 'tv' : 'movie');

function titleKey({ tmdbId, type, season, episode }) {
    return { tmdb_id: int0(tmdbId), type: normType(type), season: int0(season), episode: int0(episode) };
}

/**
 * The address of the MEDIA, not of this particular signed request.
 *
 * Same concept as mediaIdentity() in providers/castletv.js (query dropped, the
 * rotating `_<NNN>.m3u8` suffix dropped) and the host+path cache key in
 * lib/media/mp4AudioProbe.js. Host is kept so two CDNs that both serve an
 * `/index.m3u8` never share evidence. A proxied url (`/m3u8-proxy?url=...`)
 * is unwrapped so the identity survives routeStreamsForBrowser.
 */
function mediaIdentityOf(url, depth = 0) {
    if (!url) return '';
    let u;
    try { u = new URL(String(url), 'http://local.invalid'); } catch { return ''; }
    const inner = u.searchParams.get('url');
    if (inner && depth < 2 && /^https?:\/\//i.test(inner)) return mediaIdentityOf(inner, depth + 1);
    const host = u.hostname === 'local.invalid' ? '' : u.hostname.toLowerCase();
    const p = u.pathname.replace(/_(\d+)(\.m3u8)$/i, '$2');
    return (host + p).slice(0, 300);
}

// ---- SQLite backend --------------------------------------------------------

function sqliteBackend(file) {
    const Database = require('better-sqlite3');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');

    const migrate = db.transaction(() => {
        let v = db.pragma('user_version', { simple: true });
        for (; v < MIGRATIONS.length; v++) {
            db.exec(MIGRATIONS[v]);
            db.pragma(`user_version = ${v + 1}`);
        }
    });
    migrate();

    const q = {
        statsGet: db.prepare(`select * from source_stats where tmdb_id=? and type=? and season=? and episode=?
                              and provider=? and media_identity=?`),
        statsForTitle: db.prepare('select * from source_stats where tmdb_id=? and type=? and season=? and episode=?'),
        statsUpsert: db.prepare(`insert into source_stats
            (tmdb_id,type,season,episode,provider,media_identity,played_ok_at,play_failed_at,play_fail_reason,
             play_fails,startup_ms,wait_ms,stall_count,stall_ms,recovery_count,play_device,play_connection,
             audio_lang,updated_at)
            values (@tmdb_id,@type,@season,@episode,@provider,@media_identity,@played_ok_at,@play_failed_at,
             @play_fail_reason,@play_fails,@startup_ms,@wait_ms,@stall_count,@stall_ms,@recovery_count,
             @play_device,@play_connection,@audio_lang,@updated_at)
            on conflict (tmdb_id,type,season,episode,provider,media_identity) do update set
             played_ok_at=excluded.played_ok_at, play_failed_at=excluded.play_failed_at,
             play_fail_reason=excluded.play_fail_reason, play_fails=excluded.play_fails,
             startup_ms=excluded.startup_ms, wait_ms=excluded.wait_ms, stall_count=excluded.stall_count,
             stall_ms=excluded.stall_ms, recovery_count=excluded.recovery_count,
             play_device=excluded.play_device, play_connection=excluded.play_connection,
             audio_lang=excluded.audio_lang, updated_at=excluded.updated_at`),
        evidenceUpsert: db.prepare(`insert into audio_evidence
            (tmdb_id,type,s,e,provider,media_identity,lang,source,confidence,refuted,detail,at)
            values (@tmdb_id,@type,@s,@e,@provider,@media_identity,@lang,@source,@confidence,@refuted,@detail,@at)
            on conflict (media_identity,provider,source,lang) do update set
             tmdb_id=coalesce(excluded.tmdb_id, tmdb_id), type=coalesce(excluded.type, type),
             s=excluded.s, e=excluded.e, confidence=excluded.confidence, refuted=excluded.refuted,
             detail=excluded.detail, at=excluded.at`),
        evidenceFor: db.prepare('select * from audio_evidence where media_identity=? order by at asc, id asc'),
        healthGet: db.prepare('select * from provider_health where provider=?'),
        healthAll: db.prepare('select * from provider_health'),
        healthUpsert: db.prepare(`insert into provider_health
            (provider,attempts,successes,ema_latency_ms,consecutive_misses,tripped_until,trips,last_miss_title,
             last_ok_at,updated_at)
            values (@provider,@attempts,@successes,@ema_latency_ms,@consecutive_misses,@tripped_until,@trips,
             @last_miss_title,@last_ok_at,@updated_at)
            on conflict (provider) do update set attempts=excluded.attempts, successes=excluded.successes,
             ema_latency_ms=excluded.ema_latency_ms, consecutive_misses=excluded.consecutive_misses,
             tripped_until=excluded.tripped_until, trips=excluded.trips, last_miss_title=excluded.last_miss_title,
             last_ok_at=excluded.last_ok_at, updated_at=excluded.updated_at`),
        demuxJobGet: db.prepare('select spec, expires_at from castle_demux_job where id=?'),
        demuxJobUpsert: db.prepare(`insert into castle_demux_job (id,spec,expires_at,updated_at)
            values (@id,@spec,@expires_at,@updated_at)
            on conflict (id) do update set spec=excluded.spec, expires_at=excluded.expires_at,
             updated_at=excluded.updated_at`),
        demuxJobTouch: db.prepare('update castle_demux_job set expires_at=?, updated_at=? where id=?'),
        demuxJobPrune: db.prepare('delete from castle_demux_job where expires_at < ?'),
        canaryGet: db.prepare('select * from provider_canary where provider=?'),
        canaryAll: db.prepare('select * from provider_canary'),
        canaryUpsert: db.prepare(`insert into provider_canary
            (provider,state,kind,last_run_at,last_ok_at,next_due_at,last_error,telugu_ok,heal_how,heal_at,runs,fails)
            values (@provider,@state,@kind,@last_run_at,@last_ok_at,@next_due_at,@last_error,@telugu_ok,@heal_how,
             @heal_at,@runs,@fails)
            on conflict (provider) do update set state=excluded.state, kind=excluded.kind,
             last_run_at=excluded.last_run_at, last_ok_at=excluded.last_ok_at, next_due_at=excluded.next_due_at,
             last_error=excluded.last_error, telugu_ok=excluded.telugu_ok, heal_how=excluded.heal_how,
             heal_at=excluded.heal_at, runs=excluded.runs, fails=excluded.fails`),
        lkgUpsert: db.prepare(`insert into last_known_good
            (tmdb_id,type,season,episode,provider,media_identity,row,expires_at,stored_at)
            values (@tmdb_id,@type,@season,@episode,@provider,@media_identity,@row,@expires_at,@stored_at)
            on conflict (tmdb_id,type,season,episode,provider,media_identity) do update set
             row=excluded.row, expires_at=excluded.expires_at, stored_at=excluded.stored_at`),
        lkgFor: db.prepare(`select * from last_known_good where tmdb_id=? and type=? and season=? and episode=?
                            and expires_at > ? order by stored_at desc`),
        lkgEvict: db.prepare(`delete from last_known_good where tmdb_id=? and type=? and season=? and episode=?
                              and provider=? and media_identity=?`),
        lkgPrune: db.prepare('delete from last_known_good where expires_at <= ?'),
        playStatsByProvider: db.prepare(`select provider, sum(case when played_ok_at is not null and play_fails=0 then 1 else 0 end) as ok,
            sum(case when play_fails>0 then 1 else 0 end) as fail from source_stats group by provider`),
    };

    return {
        kind: 'sqlite',
        userVersion: () => db.pragma('user_version', { simple: true }),
        statsGet: (k) => q.statsGet.get(k.tmdb_id, k.type, k.season, k.episode, k.provider, k.media_identity),
        statsForTitle: (k) => q.statsForTitle.all(k.tmdb_id, k.type, k.season, k.episode),
        statsPut: (row) => { q.statsUpsert.run(row); },
        evidencePut: (row) => { q.evidenceUpsert.run(row); },
        evidenceFor: (id) => q.evidenceFor.all(id),
        healthGet: (name) => q.healthGet.get(name),
        healthAll: () => q.healthAll.all(),
        healthPut: (row) => { q.healthUpsert.run(row); },
        demuxJobGet: (id) => q.demuxJobGet.get(id),
        demuxJobPut: (row) => { q.demuxJobUpsert.run(row); },
        demuxJobTouch: (id, expiresAt, at) => { q.demuxJobTouch.run(expiresAt, at, id); },
        demuxJobPrune: (at) => q.demuxJobPrune.run(at).changes,
        canaryGet: (name) => q.canaryGet.get(name),
        canaryAll: () => q.canaryAll.all(),
        canaryPut: (row) => { q.canaryUpsert.run(row); },
        lkgPut: (row) => { q.lkgUpsert.run(row); },
        lkgFor: (k, at) => q.lkgFor.all(k.tmdb_id, k.type, k.season, k.episode, at),
        lkgEvict: (k, provider, id) => q.lkgEvict.run(k.tmdb_id, k.type, k.season, k.episode, provider, id).changes,
        lkgPrune: (at) => q.lkgPrune.run(at).changes,
        playStatsByProvider: () => q.playStatsByProvider.all(),
        close: () => db.close(),
    };
}

// ---- JSON fallback backend ------------------------------------------------
//
// Same helpers over plain objects, flushed to one JSON file (write-then-rename
// so a crash mid-write never leaves half a file). Only used when better-sqlite3
// cannot load; slower and coarser, but it still survives a restart.

function jsonBackend(file) {
    const empty = () => ({ version: MIGRATIONS.length, source_stats: {}, audio_evidence: [], provider_health: {},
        castle_demux_job: {}, provider_canary: {}, last_known_good: {} });
    let data = empty();
    let writable = file !== ':memory:';
    if (writable) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            if (fs.existsSync(file)) data = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
        } catch (e) {
            console.error(`[store] JSON store unreadable at ${file}: ${e.message} - starting empty`);
        }
    }
    let timer = null;
    const flushNow = () => {
        timer = null;
        if (!writable) return;
        try {
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(data));
            fs.renameSync(tmp, file);
        } catch (e) {
            writable = false;
            console.error(`[store] JSON store cannot be written at ${file}: ${e.message} - IN MEMORY ONLY from now`);
        }
    };
    const flush = () => { if (!timer) { timer = setTimeout(flushNow, 200); timer.unref?.(); } };
    const statsId = (k) => [k.tmdb_id, k.type, k.season, k.episode, k.provider, k.media_identity].join('|');
    const lkgId = statsId;
    let nextId = data.audio_evidence.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;

    return {
        kind: 'json',
        userVersion: () => data.version,
        statsGet: (k) => data.source_stats[statsId(k)],
        statsForTitle: (k) => Object.values(data.source_stats).filter((r) =>
            r.tmdb_id === k.tmdb_id && r.type === k.type && r.season === k.season && r.episode === k.episode),
        statsPut: (row) => { data.source_stats[statsId(row)] = { ...row }; flush(); },
        evidencePut: (row) => {
            const i = data.audio_evidence.findIndex((r) => r.media_identity === row.media_identity
                && r.provider === row.provider && r.source === row.source && r.lang === row.lang);
            if (i >= 0) data.audio_evidence[i] = { ...data.audio_evidence[i], ...row, id: data.audio_evidence[i].id };
            else data.audio_evidence.push({ ...row, id: nextId++ });
            flush();
        },
        evidenceFor: (id) => data.audio_evidence.filter((r) => r.media_identity === id)
            .sort((a, b) => a.at - b.at || a.id - b.id),
        healthGet: (name) => data.provider_health[name],
        healthAll: () => Object.values(data.provider_health),
        healthPut: (row) => { data.provider_health[row.provider] = { ...row }; flush(); },
        demuxJobGet: (id) => data.castle_demux_job[id],
        demuxJobPut: (row) => { data.castle_demux_job[row.id] = { ...row }; flush(); },
        demuxJobTouch: (id, expiresAt, at) => {
            const r = data.castle_demux_job[id];
            if (r) { r.expires_at = expiresAt; r.updated_at = at; flush(); }
        },
        demuxJobPrune: (at) => {
            let n = 0;
            for (const [id, r] of Object.entries(data.castle_demux_job)) {
                if (r.expires_at < at) { delete data.castle_demux_job[id]; n++; }
            }
            if (n) flush();
            return n;
        },
        canaryGet: (name) => data.provider_canary[name],
        canaryAll: () => Object.values(data.provider_canary),
        canaryPut: (row) => { data.provider_canary[row.provider] = { ...row }; flush(); },
        lkgPut: (row) => { data.last_known_good[lkgId(row)] = { ...row }; flush(); },
        lkgFor: (k, at) => Object.values(data.last_known_good).filter((r) => r.tmdb_id === k.tmdb_id
            && r.type === k.type && r.season === k.season && r.episode === k.episode && r.expires_at > at)
            .sort((a, b) => b.stored_at - a.stored_at),
        lkgEvict: (k, provider, id) => {
            const key = lkgId({ ...k, provider, media_identity: id });
            if (!data.last_known_good[key]) return 0;
            delete data.last_known_good[key]; flush(); return 1;
        },
        lkgPrune: (at) => {
            let n = 0;
            for (const [id, r] of Object.entries(data.last_known_good)) {
                if (r.expires_at <= at) { delete data.last_known_good[id]; n++; }
            }
            if (n) flush();
            return n;
        },
        playStatsByProvider: () => {
            const m = new Map();
            for (const r of Object.values(data.source_stats)) {
                const e = m.get(r.provider) || { provider: r.provider, ok: 0, fail: 0 };
                if (r.played_ok_at != null && !r.play_fails) e.ok++;
                if (r.play_fails > 0) e.fail++;
                m.set(r.provider, e);
            }
            return [...m.values()];
        },
        close: () => { if (timer) { clearTimeout(timer); flushNow(); } },
    };
}

// ---- the store ------------------------------------------------------------

function openStore(file = DEFAULT_PATH, { backend } = {}) {
    let b = null;
    let warning = null;
    if (backend !== 'json') {
        try { b = sqliteBackend(file); }
        catch (e) {
            warning = `better-sqlite3 unavailable (${String(e.message).split('\n')[0]})`;
        }
    }
    if (!b) {
        const jsonFile = file === ':memory:' ? file : file.replace(/\.sqlite$/, '') + '.json';
        b = jsonBackend(jsonFile);
        if (warning) {
            console.error(`[store] !!! ${warning} - FALLING BACK to JSON file ${jsonFile}. `
                + 'Learning survives restarts but is slower; fix the native module.');
        }
    }
    const now = () => Date.now();

    /**
     * Record what a browser saw when it tried a source. A success clears the
     * failure count (a source that failed once on bad wifi and plays now is
     * not a failing source); a failure adds one. Input must already be
     * bounded - see clampPlaybackReport in apiServer.js.
     */
    function recordPlayback(r) {
        const k = { ...titleKey(r), provider: lc(r.provider), media_identity: String(r.mediaIdentity || '') };
        const prev = b.statsGet(k) || {};
        const at = now();
        const row = {
            ...k,
            played_ok_at: r.ok ? at : (prev.played_ok_at ?? null),
            play_failed_at: r.ok ? (prev.play_failed_at ?? null) : at,
            play_fail_reason: r.ok ? null : (r.reason || 'unknown'),
            play_fails: r.ok ? 0 : (prev.play_fails || 0) + 1,
            startup_ms: r.startupMs ?? null,
            wait_ms: r.waitMs ?? prev.wait_ms ?? null,
            stall_count: r.stallCount ?? null,
            stall_ms: r.stallMs ?? null,
            recovery_count: r.recoveryCount ?? null,
            play_device: r.device ?? null,
            play_connection: r.connection ?? null,
            audio_lang: r.audioLang ?? prev.audio_lang ?? null,
            updated_at: at,
        };
        b.statsPut(row);
        return row;
    }

    /** Every source_stats row for one title (all providers, all identities). */
    function sourceStatsFor(title) { return b.statsForTitle(titleKey(title)); }

    function putAudioEvidence(ev) {
        const source = String(ev.source || '');
        if (!AUDIO_SOURCES.includes(source)) throw new Error(`bad audio evidence source: ${source}`);
        if (!ev.mediaIdentity) return null;
        const t = ev.tmdbId != null ? titleKey(ev) : { tmdb_id: null, type: null, season: 0, episode: 0 };
        const row = {
            tmdb_id: t.tmdb_id, type: t.type, s: t.season, e: t.episode,
            provider: lc(ev.provider),
            media_identity: String(ev.mediaIdentity).slice(0, 300),
            lang: String(ev.lang || ''),
            source,
            confidence: ev.confidence != null ? Number(ev.confidence) : SOURCE_CONFIDENCE[source],
            refuted: ev.refuted ? 1 : 0,
            detail: ev.detail == null ? null : JSON.stringify(ev.detail),
            at: now(),
        };
        b.evidencePut(row);
        return row;
    }

    function audioEvidenceFor(mediaIdentity) {
        if (!mediaIdentity) return [];
        return b.evidenceFor(String(mediaIdentity)).map((r) => ({
            ...r, detail: r.detail ? safeParse(r.detail) : null,
        }));
    }

    function providerHealth(name) { return b.healthGet(lc(name)) || null; }
    function allProviderHealth() { return b.healthAll(); }
    function saveProviderHealth(name, fields) {
        const key = lc(name);
        const prev = b.healthGet(key) || { provider: key, attempts: 0, successes: 0, ema_latency_ms: null,
            consecutive_misses: 0, tripped_until: null, trips: 0, last_miss_title: null, last_ok_at: null };
        const row = { ...prev, ...fields, provider: key, updated_at: now() };
        b.healthPut(row);
        return row;
    }

    // castle-demux job specs (lib/media/republish.js). The spec is JSON the
    // caller owns; this layer only stores it with an expiry.
    function putDemuxJob(id, spec, expiresAt) {
        b.demuxJobPut({ id: String(id), spec: JSON.stringify(spec), expires_at: Math.trunc(expiresAt), updated_at: now() });
    }
    function getDemuxJob(id) {
        const r = b.demuxJobGet(String(id));
        if (!r || r.expires_at < now()) return null;
        return safeParse(r.spec);
    }
    function touchDemuxJob(id, expiresAt) { b.demuxJobTouch(String(id), Math.trunc(expiresAt), now()); }
    function pruneDemuxJobs() { return b.demuxJobPrune(now()); }

    // provider canary rows (lib/selfheal/canary.js). canaryPut merges fields
    // into the provider's row.
    const CANARY_EMPTY = { state: null, kind: null, last_run_at: null, last_ok_at: null, next_due_at: null,
        last_error: null, telugu_ok: null, heal_how: null, heal_at: null, runs: 0, fails: 0 };
    function canaryGet(name) { return b.canaryGet(lc(name)) || null; }
    function canaryAll() { return b.canaryAll(); }
    function canaryPut(name, fields) {
        const key = lc(name);
        const row = { ...CANARY_EMPTY, ...(b.canaryGet(key) || {}), ...fields, provider: key };
        b.canaryPut(row);
        return row;
    }

    // last-known-good rows (lib/mmhub/lastKnownGood.js). The row JSON is the
    // caller's; this layer stores it with an expiry and never reads tags.
    function lkgPut(e) {
        const k = { ...titleKey(e), provider: lc(e.provider), media_identity: String(e.mediaIdentity || '').slice(0, 300) };
        b.lkgPut({ ...k, row: JSON.stringify(e.row), expires_at: Math.trunc(e.expiresAt), stored_at: Math.trunc(e.storedAt ?? now()) });
    }
    function lkgFor(title, at = now()) {
        return b.lkgFor(titleKey(title), at).map((r) => ({ provider: r.provider, mediaIdentity: r.media_identity,
            row: safeParse(r.row), expiresAt: r.expires_at, storedAt: r.stored_at })).filter((r) => r.row);
    }
    function lkgEvict(title, provider, mediaIdentity) {
        return b.lkgEvict(titleKey(title), lc(provider), String(mediaIdentity || ''));
    }
    function lkgPrune(at = now()) { return b.lkgPrune(at); }
    // Playback-report outcomes per provider across every title: rows whose last
    // report played (ok) and rows with failures (fail). Learned ranking input.
    function playStatsByProvider() { return b.playStatsByProvider(); }

    return {
        get backend() { return b.kind; },
        // Why sqlite was not used, or null. Health reports it so a silent
        // JSON fallback (native module failed to load) is visible.
        warning,
        file,
        userVersion: () => b.userVersion(),
        recordPlayback, sourceStatsFor,
        putAudioEvidence, audioEvidenceFor,
        providerHealth, allProviderHealth, saveProviderHealth,
        putDemuxJob, getDemuxJob, touchDemuxJob, pruneDemuxJobs,
        canaryGet, canaryAll, canaryPut,
        lkgPut, lkgFor, lkgEvict, lkgPrune, playStatsByProvider,
        close: () => b.close(),
    };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * Read stored evidence for one file.
 *
 * Returns the stored probe answer (when one exists with enough confidence)
 * plus the language claims layered on top of it:
 *   positive  languages a viewer confirmed, or a provider/manifest stated
 *   refuted   languages a viewer said are NOT what played. Latest viewer
 *             word on a language wins over everything else about it.
 */
function resolveAudioEvidence(rows, kind) {
    let probe = null;
    const positive = new Set();
    const refuted = new Set();
    for (const r of rows) {           // oldest first, so later rows overwrite
        if (r.source === 'ffprobe' && !r.lang) {
            if (r.confidence >= MIN_SKIP_CONFIDENCE && r.detail && r.detail.kind === kind) probe = r.detail.value;
            continue;
        }
        if (!r.lang) continue;
        const key = r.lang.toLowerCase();
        if (r.refuted) { if (r.source === 'viewer') { refuted.add(key); positive.delete(key); } continue; }
        if (r.confidence < MIN_SKIP_CONFIDENCE && r.source !== 'provider') continue;
        if (r.source === 'viewer') refuted.delete(key);
        if (!refuted.has(key)) positive.add(key);
    }
    return { probe, positive, refuted };
}

let singleton = null;
function storePathFromEnv() {
    if (process.env.TMDB_STORE_PATH) return process.env.TMDB_STORE_PATH;
    // Under `node --test` with no explicit path, never touch the real data/
    // file: each test process gets its own throwaway in-memory DB.
    if (process.env.NODE_TEST_CONTEXT) return ':memory:';
    return DEFAULT_PATH;
}

/** The process-wide store, opened on first use. Never throws. */
function getStore() {
    if (singleton) return singleton;
    const file = storePathFromEnv();
    try {
        singleton = openStore(file);
    } catch (e) {
        console.error(`[store] !!! cannot open ${file}: ${e.message} - LEARNING IS IN MEMORY ONLY this run`);
        singleton = openStore(':memory:');
        singleton.inMemoryOnly = true;
    }
    if (file !== ':memory:') console.log(`[store] ${singleton.backend} store at ${file} (schema v${singleton.userVersion()})`);
    return singleton;
}

/**
 * Store state for /api/health: "sqlite", or "json-fallback" when the native
 * module failed and learning went to the JSON file. "memory" when even the
 * file could not be opened. Never throws.
 */
function storeStatus() {
    try {
        const s = getStore();
        const mode = s.inMemoryOnly ? 'memory' : (s.backend === 'sqlite' ? 'sqlite' : 'json-fallback');
        return { store: mode, storeWarning: s.warning || null };
    } catch (e) {
        return { store: 'error', storeWarning: String(e && e.message) };
    }
}

/** Tests only: swap the process-wide store. */
function _setStore(s) { singleton = s; }

module.exports = {
    openStore, getStore, storeStatus, _setStore, mediaIdentityOf, resolveAudioEvidence,
    SOURCE_CONFIDENCE, MIN_SKIP_CONFIDENCE, DEFAULT_PATH, MIGRATIONS,
};
