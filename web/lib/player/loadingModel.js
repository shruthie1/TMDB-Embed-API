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
export const LOADING_SLOW_HINT_MS = 15000;
export const LOADING_CHOOSER_MS = 30000;
export const LOADING_RETRY_MS = 30000;

export const CHECK_SERVER = 'check:server';

export const Phase = {
  FINDING: 'finding', FINDING_SLOW: 'finding-slow', FOUND: 'found', STARTING: 'starting',
  ADVANCING: 'advancing', ADVANCING_SKIP: 'advancing-skip', FAILED: 'failed',
};

export const RowState = {
  WAITING: 'waiting', CHECKING: 'checking', STARTING: 'starting',
  PLAYING: 'playing', SKIPPED: 'skipped', FAILED: 'failed',
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
};

/** Search-phase Try again re-asks the server only; on the end card it is a full refresh. */
export function retryPlan(failed) {
  return failed ? { refresh: true, keepDevice: false } : { refresh: false, keepDevice: true };
}

export function advanceNotice(from, to, skip = false) {
  const a = from || 'That server';
  const b = to || 'the next server';
  return skip ? `${a} won't play on this device. Trying ${b}.` : `${a} is slow. Trying ${b}.`;
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
 */
export function loadingView(i) {
  const preferred = i.preferred || PREFERRED_LANGUAGE;
  const t = i.now - i.playAt;
  const list = i.sources || null;
  const labels = i.labels || {};
  const attempts = i.attempts || [];
  const label = (id) => labels[id] ?? list?.find((s) => s.id === id)?.provider ?? String(id);
  const n = i.firstListSize > 0 ? i.firstListSize : (list?.length || 0);
  const more = (list?.length || 0) - n;
  const k = attempts.length;
  const tried = `${k} of ${n} tried${more > 0 ? ` · ${more} more found` : ''}`;

  const rows = list == null ? checkRows(i) : sourceRows(i, list, label, preferred);
  const footer = `Started ${secs(t)}s ago${list != null ? ` · ${k} of ${n} tried` : ''}`;
  const view = (phase, headline, detail, showChooser, showTryAgain) =>
    ({ phase, headline, detail, showChooser, showTryAgain, rows, footer });

  if (i.failed) {
    const distinct = new Set(attempts.map((a) => a.id)).size;
    const detail = distinct > 0
      ? `We tried ${distinct} sources. None of them played.`
      : (i.failMessage || 'No playable source found.');
    return view(Phase.FAILED, `Couldn't start ${i.title}`, detail, false, true);
  }
  if (list == null) {
    const slow = t >= LOADING_SLOW_HINT_MS;
    const detail = slow ? 'First play of a title can take up to a minute.'
      : `${preferred} first${t >= 5000 ? ` · ${secs(t)}s` : ''}`;
    return view(slow ? Phase.FINDING_SLOW : Phase.FINDING,
      slow ? 'Still finding sources…' : 'Finding sources…', detail, false, t >= LOADING_RETRY_MS);
  }
  const chooser = !i.framed && t >= LOADING_CHOOSER_MS;
  const cur = attempts[attempts.length - 1];
  if (!cur) {
    const inLang = list.filter((s) => (s.languages || []).some(
      (l) => langName(l).toLowerCase() === preferred.toLowerCase())).length;
    return view(Phase.FOUND, `Found ${list.length} sources`, `${inLang} in ${preferred}`, chooser, false);
  }
  const s = list.find((x) => x.id === cur.id);
  const facts = [s && langOf(s, preferred), s && qualityOf(s)].filter(Boolean);
  const prev = attempts[attempts.length - 2];
  if (!prev) return view(Phase.STARTING, `Starting ${label(cur.id)}`, facts.join(' · '), chooser, false);
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
    else if (a.state === RowState.SKIPPED) { state = RowState.SKIPPED; status = `Skipped: ${a.reason || Reason.UNSUPPORTED}`; }
    else { state = RowState.FAILED; status = `Failed: ${a.reason || Reason.STOPPED} · ${secs(a.endedAt - a.startedAt)}s`; }
    let clickable = false;
    if (state === RowState.WAITING || state === RowState.FAILED) clickable = !s.unsupported;
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
