import { PREFERRED_LANGUAGE } from '../backend';
import { heightOf } from './trackChoices';

/**
 * The player's loading screen as a pure function (loading-ux spec, shared with
 * android/.../player/LoadingModel.kt: same constants, same strings).
 *
 * One clock (`playAt`) for the whole start. No "Try again" while anything is
 * still loading: it shows only after 30s with no source list, or on the end
 * card. From 30s with a list and no frame, "Choose a server" opens Details.
 */
/** Failure card headlines (owner 2026-11-24). NO_SOURCES takes " for <title>". */
export const FAIL_COPY = Object.freeze({ COULDNT_PLAY: "Couldn't play any source", NO_SOURCES: 'No sources found' });
export const noSourcesHeadline = (title) => (title ? `${FAIL_COPY.NO_SOURCES} for ${title}` : FAIL_COPY.NO_SOURCES);

/** Where TV focus starts: Try again on the end card, Details while loading (LoadingModel.tvFocus). */
export const tvFocus = (v) => (v?.phase === 'failed' ? 'retry' : 'details');

export const LOADING_SLOW_HINT_MS = 15000;
export const LOADING_CHOOSER_MS = 30000;
export const LOADING_RETRY_MS = 30000;
/** No rows at all after this long: the search ends on the no-sources card
 *  instead of counting up (owner 2026-11-24). */
export const LOADING_NO_SOURCES_MS = 45000;

/**
 * Caps for "Add <L> audio from another server" (Step 2, 2026-11-21): at most
 * 3 donor servers, 15s per try, 30s for the whole journey. Same names and
 * values in the APK's LoadingModel.kt.
 */
export const ADD_AUDIO_MAX_TRIES = 3;
export const ADD_AUDIO_TRY_MS = 15000;
export const ADD_AUDIO_TOTAL_MS = 30000;

export const CHECK_SERVER = 'check:server';

export const Phase = {
  FINDING: 'finding', FINDING_SLOW: 'finding-slow', FOUND: 'found', STARTING: 'starting',
  SWITCHING: 'switching', ADVANCING: 'advancing', ADVANCING_SKIP: 'advancing-skip', FAILED: 'failed',
};

export const RowState = {
  WAITING: 'waiting', CHECKING: 'checking', STARTING: 'starting',
  PLAYING: 'playing', SKIPPED: 'skipped', FAILED: 'failed',
  // The viewer picked another server while this row was starting. Neutral:
  // not a failure, and not counted in "N of M tried" or "We tried N".
  LEFT: 'left',
};

/** The fixed set of reasons a row did not play. */
export const Reason = {
  NO_ANSWER: 'no answer in 8s',
  NO_PICTURE: 'no picture in 20s',
  UNSUPPORTED: "won't play on this device",
  EXPIRED: 'link expired',
  STOPPED: 'stopped loading',
  SERVER: 'server error',
  NOT_FOUND: 'not found',
  NOT_TELUGU: 'not Telugu',
  // Web only: the 15s startup verdict (Player.jsx STARTUP_SWITCH_MS). The APK has none.
  NO_PICTURE_STARTUP: 'no picture in 15s',
  // Web only: no picture and no other row by 45 s (useStartupSwitch STARTUP_GIVE_UP_MS).
  NO_PICTURE_GIVE_UP: 'no picture in 45s',
};

/** Search-phase Try again re-asks the server only; on the end card it is a full refresh. */
export function retryPlan(failed) {
  return failed ? { refresh: true, keepDevice: false } : { refresh: false, keepDevice: true };
}

/**
 * Every loading and switch line the viewer reads, in one place so the APK's
 * LoadingModel.kt can mirror them word for word (Task 6, 2026-11-21).
 *
 * No line says "slow": the player cannot tell a slow source from a dead one
 * (it sees no throughput, only "no answer in 8s" or "no picture in 20s"), and
 * the owner read "slow" on almost every switch while the server was fine.
 */
export const Copy = {
  /** A server switch the viewer asked for is in flight. */
  SWITCHING_SERVER: 'Switching server…',
  /** The source list is still on its way. */
  FINDING: 'Finding sources…',
  /** The source list took longer than LOADING_SLOW_HINT_MS, with no switch in flight. */
  FINDING_SLOW: 'Still finding sources…',
  FINDING_SLOW_DETAIL: 'First play of a title can take up to a minute.',
  /** A source gave no picture in time and the player moves on by itself. */
  didntStart: (from, to) => `${from} didn't start. Trying ${to}.`,
  /** A source that was playing failed mid-film and the player moves on. */
  stopped: (from, to) => `${from} stopped. Trying ${to}.`,
  /** The device cannot decode the source. */
  wontPlay: (from, to) => `${from} won't play on this device. Trying ${to}.`,
  /** A language pick landed on a server that plays, but without that language (I2). */
  noLanguage: (from, lang, to) => `${from} has no ${lang} audio. Trying ${to}.`,
  /** Row status: the viewer picked another server while this one was starting. */
  ROW_LEFT: 'Left',
  /** Add <L> audio from another server (Step 2): the Details group heading. */
  ADD_AUDIO_GROUP: 'Add audio from another server',
  /** One row per missing language under ADD_AUDIO_GROUP. */
  addAudio: (lang) => `Add ${lang} audio from another server`,
  /** A donor server is being checked; n of total donors (total <= ADD_AUDIO_MAX_TRIES). */
  checkingAudio: (lang, server, n, total) => `Checking ${server} for ${lang} audio (${n} of ${total})…`,
  /** The pair plays: the language now comes from the donor server. */
  audioAdded: (lang, server) => `${lang} audio added from ${server}.`,
  /** Every donor failed or the caps ran out; the previous stream is back. */
  noWorkingAudio: (lang) => `No server has working ${lang} audio. Playback is unchanged.`,
};

/**
 * The one-line notice when the player moves from one source to the next by
 * itself. `skip`: the device cannot decode it. `missingLang`: it played, but
 * not in the language the viewer picked. `stopped`: it was playing and died
 * mid-film. Otherwise it failed to start.
 */
export function advanceNotice(from, to, skip = false, stopped = false, missingLang = null) {
  const a = from || 'That server';
  const b = to || 'the next server';
  if (skip) return Copy.wontPlay(a, b);
  if (missingLang) return Copy.noLanguage(a, missingLang, b);
  return stopped ? Copy.stopped(a, b) : Copy.didntStart(a, b);
}

export function reasonFor(httpCode, decoder) {
  if (decoder) return Reason.UNSUPPORTED;
  if (httpCode === 403 || httpCode === 410) return Reason.EXPIRED;
  if (httpCode === 404) return Reason.NOT_FOUND;
  if (httpCode != null && httpCode >= 500) return Reason.SERVER;
  return Reason.STOPPED;
}

/**
 * A player-side failure word (fatalPolicy kind, or the reason string the
 * player reports) as one of the fixed reasons the viewer reads.
 */
export function reasonFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return Reason.STOPPED;
  if (t === 'stale' || t.includes('stale') || t.includes('expired')) return Reason.EXPIRED;
  if (t === 'codecs' || t === 'novideo' || t.includes('codec') || t.includes('no video')) return Reason.UNSUPPORTED;
  if (t.includes('startup timeout')) return Reason.NO_PICTURE_STARTUP;
  if (t.includes('startup give-up')) return Reason.NO_PICTURE_GIVE_UP;
  if (t === 'unreachable' || t.includes('not responding')) return Reason.SERVER;
  if (t.includes('404') || t.includes('not found')) return Reason.NOT_FOUND;
  return Reason.STOPPED;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One stable label per row id over the full list, dead rows included: a label
 * never changes during a start. New rows of a provider that already has a
 * label are numbered after it ("showsst" then "showsst 2"). Returns a new
 * object; `prev` is not changed.
 */
export function labelRows(prev = {}, all = []) {
  const out = { ...prev };
  const groups = new Map();
  for (const s of all) {
    if (!s || s.id == null || out[s.id] != null) continue;
    const p = s.provider || 'Server';
    if (!groups.has(p)) groups.set(p, []);
    if (!groups.get(p).some((x) => x.id === s.id)) groups.get(p).push(s);
  }
  for (const [provider, rows] of groups) {
    const numbered = new RegExp(`^${escapeRe(provider)}( \\d+)?$`);
    const existing = Object.values(out).filter((l) => numbered.test(l)).length;
    if (existing === 0 && rows.length === 1) { out[rows[0].id] = provider; continue; }
    rows.forEach((s, i) => { out[s.id] = `${provider} ${existing + i + 1}`; });
  }
  return out;
}

const LANG_NAMES = {
  te: 'Telugu', tel: 'Telugu', hi: 'Hindi', hin: 'Hindi', ta: 'Tamil', tam: 'Tamil',
  ml: 'Malayalam', mal: 'Malayalam', kn: 'Kannada', kan: 'Kannada', en: 'English', eng: 'English',
  bn: 'Bengali', ben: 'Bengali', mr: 'Marathi', mar: 'Marathi',
};
/** "te" -> "Telugu": a language is shown by name, never by code. */
export function langName(l) {
  const s = String(l || '').trim();
  return LANG_NAMES[s.toLowerCase()] || s;
}

/** The language that will play: the preferred one when the row has it, else its first. */
export function langOf(s, preferred = PREFERRED_LANGUAGE) {
  const names = (s?.languages || []).map(langName).filter(Boolean);
  return names.find((n) => n.toLowerCase() === String(preferred).toLowerCase()) || names[0] || null;
}

function qualityOf(s) {
  const h = heightOf(s);
  return h > 0 ? `${h}p` : null;
}

const secs = (ms) => Math.floor(Math.max(0, ms) / 1000);
const secs1 = (ms) => (Math.max(0, ms) / 1000).toFixed(1);

/**
 * @param {object} i
 *   now, playAt, title, preferred,
 *   sources      null until the source list exists
 *   labels       { [id]: label } from labelRows
 *   firstListSize, attempts [{id, startedAt, endedAt, state, reason}],
 *   checks [{id, label, startedAt, endedAt, found}], framed, failed, failMessage
 *   switching    true while a server switch the VIEWER asked for is in flight.
 *                It wins over the slow hint and over the advance notice: the
 *                wait is the switch, not a slow or failed server.
 */
export function loadingView(i) {
  const preferred = i.preferred || PREFERRED_LANGUAGE;
  const t = i.now - i.playAt;
  const list = i.sources || null;
  const labels = i.labels || {};
  const attempts = i.attempts || [];
  // A row the viewer left by picking another server was not tried.
  const triedAttempts = attempts.filter((a) => a.state !== RowState.LEFT);
  const label = (id) => labels[id] ?? list?.find((s) => s.id === id)?.provider ?? String(id);
  const n = i.firstListSize > 0 ? i.firstListSize : (list?.length || 0);
  const more = (list?.length || 0) - n;
  const k = triedAttempts.length;
  const tried = `${k} of ${n} tried${more > 0 ? ` · ${more} more found` : ''}`;

  const rows = list == null ? checkRows(i) : sourceRows(i, list, label, preferred);
  const footer = `Started ${secs(t)}s ago${list != null ? ` · ${k} of ${n} tried` : ''}`;
  const view = (phase, headline, detail, showChooser, showTryAgain, showRefresh = false, noSources = false) =>
    ({ phase, headline, detail, showChooser, showTryAgain, rows, footer, showRefresh, noSources });

  // The end card (owner 2026-11-24): Try again re-resolves. The streams call
  // finished with 0 rows, or 45 s passed with none: "No sources found for
  // <title>" (Try again, Back). Rows existed but all failed: "Couldn't play
  // any source" (Try again, Pick a source).
  // Counted from the latest search start (a search-phase Try again restarts it).
  const searchAt = i.checks?.[0]?.startedAt ?? i.playAt;
  const searchOver = list == null && i.now - searchAt >= LOADING_NO_SOURCES_MS;
  if (i.failed || searchOver) {
    const distinct = new Set(triedAttempts.map((a) => a.id)).size;
    const none = distinct === 0 && !list?.length;
    const detail = distinct > 0
      ? `We tried ${distinct} sources. None of them played.`
      : (i.failed && i.failMessage) || 'No playable source found.';
    return view(Phase.FAILED, none ? noSourcesHeadline(i.title) : FAIL_COPY.COULDNT_PLAY, detail,
      false, true, false, none);
  }
  const chooser = list != null && !i.framed && t >= LOADING_CHOOSER_MS;
  const cur = attempts[attempts.length - 1];
  if (i.switching) {
    const target = cur && list?.find((x) => x.id === cur.id);
    const facts = [target && langOf(target, preferred), target && qualityOf(target)].filter(Boolean);
    return view(Phase.SWITCHING, Copy.SWITCHING_SERVER,
      [...facts, ...(list != null && k > 0 ? [tried] : [])].join(' · '), chooser, false);
  }
  if (list == null) {
    const slow = t >= LOADING_SLOW_HINT_MS;
    const detail = slow ? Copy.FINDING_SLOW_DETAIL
      : `${preferred} first${t >= 5000 ? ` · ${secs(t)}s` : ''}`;
    return view(slow ? Phase.FINDING_SLOW : Phase.FINDING,
      slow ? Copy.FINDING_SLOW : Copy.FINDING, detail, false, t >= LOADING_RETRY_MS);
  }
  if (!cur) {
    const inLang = list.filter((s) => (s.languages || []).some(
      (l) => langName(l).toLowerCase() === preferred.toLowerCase())).length;
    return view(Phase.FOUND, `Found ${list.length} sources`, `${inLang} in ${preferred}`, chooser, false);
  }
  const s = list.find((x) => x.id === cur.id);
  const facts = [s && langOf(s, preferred), s && qualityOf(s)].filter(Boolean);
  const prev = attempts[attempts.length - 2];
  if (!prev || prev.state === RowState.LEFT) return view(Phase.STARTING, `Starting ${label(cur.id)}`, facts.join(' · '), chooser, false);
  const skip = prev.reason === Reason.UNSUPPORTED;
  return view(skip ? Phase.ADVANCING_SKIP : Phase.ADVANCING,
    advanceNotice(label(prev.id), label(cur.id), skip),
    [...facts, tried].join(' · '), chooser, false);
}

function checkRows(i) {
  return (i.checks || []).map((c) => {
    let status;
    if (c.endedAt == null) status = `Checking… ${secs(i.now - c.startedAt)}s`;
    else if (!c.found) status = `nothing found · ${secs1(c.endedAt - c.startedAt)}s`;
    else status = `${c.found} link${c.found === 1 ? '' : 's'} · ${secs1(c.endedAt - c.startedAt)}s`;
    return {
      id: c.id, title: c.label, status,
      state: c.endedAt == null ? RowState.CHECKING : RowState.WAITING,
      clickable: false, description: describe(c.label, status),
    };
  });
}

function sourceRows(i, list, label, preferred) {
  // Latest attempt per id, in the order rows were first tried; then the rest in list order.
  const attempts = i.attempts || [];
  const latest = new Map();
  for (const a of attempts) { latest.delete(a.id); latest.set(a.id, a); }
  const byId = new Map(list.map((s) => [s.id, s]));
  const firstTry = [...new Set(attempts.map((a) => a.id))].filter((id) => byId.has(id));
  const order = [...firstTry, ...list.map((s) => s.id).filter((id) => !latest.has(id))];
  return [...new Set(order)].map((id) => {
    const s = byId.get(id);
    const title = [label(id), langOf(s, preferred), qualityOf(s)].filter(Boolean).join(' · ');
    const a = latest.get(id);
    let state; let status;
    if (!a && s.unsupported) { state = RowState.SKIPPED; status = `Skipped: ${Reason.UNSUPPORTED}`; }
    else if (!a) { state = RowState.WAITING; status = 'Waiting'; }
    else if (a.endedAt == null) { state = RowState.STARTING; status = `Starting… ${secs(i.now - a.startedAt)}s`; }
    else if (a.state === RowState.PLAYING) { state = RowState.PLAYING; status = `Playing · ${secs1(a.endedAt - a.startedAt)}s to start`; }
    else if (a.state === RowState.LEFT) { state = RowState.LEFT; status = Copy.ROW_LEFT; }
    else if (a.state === RowState.SKIPPED) { state = RowState.SKIPPED; status = `Skipped: ${a.reason || Reason.UNSUPPORTED}`; }
    else { state = RowState.FAILED; status = `Failed: ${a.reason || Reason.STOPPED} · ${secs(a.endedAt - a.startedAt)}s`; }
    let clickable = false;
    if (state === RowState.WAITING || state === RowState.FAILED || state === RowState.LEFT) clickable = !s.unsupported;
    else if (state === RowState.SKIPPED) clickable = !s.unsupported && a?.reason !== Reason.UNSUPPORTED;
    return { id, title, status, state, clickable, description: describe(title, status) };
  });
}

/** "CastleTV 2 · Telugu · 1080p" + "Failed: … 20s" -> "CastleTV 2, Telugu, 1080p, failed: … 20 seconds". */
function describe(title, status) {
  const words = (status.charAt(0).toLowerCase() + status.slice(1))
    .replace(/(\d+(?:\.\d)?)s\b/g, '$1 seconds');
  return `${title.split(' · ').join(', ')}, ${words}`;
}
