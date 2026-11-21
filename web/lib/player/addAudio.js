/**
 * "Add <L> audio from another server" (Step 2, 2026-11-21): which languages to
 * offer, which donor servers to try, and the bounded donor run. Pure model; the
 * player wires it (Task 4). Caps: ADD_AUDIO_MAX_TRIES donors, ADD_AUDIO_TRY_MS
 * per try, ADD_AUDIO_TOTAL_MS for the whole journey. Donors are never
 * pre-validated: a try IS the check.
 */
import { languageSourceIndex, audioLanguageKey, trackAudioLanguage } from './languageSources';
import { ADD_AUDIO_MAX_TRIES, ADD_AUDIO_TRY_MS, ADD_AUDIO_TOTAL_MS } from './loadingModel';

const TELUGU = audioLanguageKey('Telugu');

/** Index rows that can lend L to the playing picture via /hybrid/pair. */
function donorsFrom(index, key, playing, failed) {
  const entry = index.byLanguage.get(key);
  if (!entry) return [];
  const ok = entry.sources.filter(s => s.id !== playing?.id
    && !s.unsupported && !s.hybrid && s.selectableAudio
    // The server refuses a same-provider pair.
    && !(playing?.provider != null && s.provider === playing.provider)
    && !failed.has(s.id));
  // A named in-stream rendition with a uri first; the index order (Telugu-first rank) inside each group.
  const withUri = ok.filter(s => entry.renditions.get(s.id)?.uri);
  const rest = ok.filter(s => !entry.renditions.get(s.id)?.uri);
  return [...withUri, ...rest].slice(0, ADD_AUDIO_MAX_TRIES);
}

export function pairDonors(sources, language, playing, failed = new Set()) {
  return donorsFrom(languageSourceIndex(sources), audioLanguageKey(language), playing, failed);
}

/**
 * One offer per language another server carries and the playing stream does
 * not. "Carries" is the live audioTracks; with none (native path), the playing
 * row's own languages. No cap on offers. Telugu first, then index order.
 */
export function addAudioOffers(sources, playing, audioTracks = []) {
  const index = languageSourceIndex(sources);
  const have = new Set();
  for (const track of audioTracks || []) {
    const language = trackAudioLanguage(track);
    if (language) have.add(audioLanguageKey(language));
  }
  // No tracks, or none with a known language: the playing row's own languages.
  if (!have.size) {
    for (const language of index.bySource.get(playing?.id) || []) have.add(audioLanguageKey(language));
  }
  const keys = [...index.byLanguage.keys()].filter(k => !have.has(k));
  keys.sort((a, b) => (b === TELUGU) - (a === TELUGU));
  const offers = [];
  for (const key of keys) {
    const donors = donorsFrom(index, key, playing, new Set());
    if (donors.length) offers.push({ language: index.byLanguage.get(key).language, donors });
  }
  return offers;
}

/** Resolves when the signal fires, so a hung try cannot hold the run. */
const onAbort = (signal, value) => new Promise(resolve => {
  if (signal.aborted) resolve(value);
  else signal.addEventListener('abort', () => resolve(value), { once: true });
});
const CANCELLED = Symbol('cancelled');

/** Like onAbort, with off() so a settled try leaves no listener on the caller's signal. */
function cancelOn(signal) {
  let off = () => {};
  const promise = new Promise(resolve => {
    if (signal.aborted) return resolve(CANCELLED);
    const fire = () => resolve(CANCELLED);
    signal.addEventListener('abort', fire, { once: true });
    off = () => signal.removeEventListener('abort', fire);
  });
  return { promise, off: () => off() };
}

/**
 * Try donors in order until one returns non-null. Each try gets a signal that
 * fires at min(tryMs, remaining budget). A throw or null is a failed donor.
 * `tried` lists every donor called, on every outcome, winner included.
 * `signal` (the caller's cancel) ends the run at once as {cancelled:true}; a
 * late success after it is never returned. `first`/`total` keep "n of total"
 * across a run's continuation.
 */
export async function tryDonors({
  donors, tryOne, onTry, signal, now = Date.now,
  totalMs = ADD_AUDIO_TOTAL_MS, tryMs = ADD_AUDIO_TRY_MS,
  first = 1, total = donors.length,
}) {
  const deadline = now() + totalMs;
  const tried = [];
  for (let i = 0; i < donors.length; i++) {
    if (signal?.aborted) return { cancelled: true, tried };
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const donor = donors[i];
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, Math.min(tryMs, remaining));
    tried.push(donor);
    let result = null;
    const cancel = signal ? cancelOn(signal) : null;
    try {
      onTry?.(donor, first + i, total);
      const races = [Promise.resolve().then(() => tryOne(donor, controller.signal)), onAbort(controller.signal, null)];
      if (cancel) races.push(cancel.promise);
      result = await Promise.race(races);
    } catch {
      result = null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      cancel?.off();
    }
    if (result === CANCELLED || signal?.aborted) return { cancelled: true, tried };
    if (result != null) return { donor, result, tried };
  }
  return { failed: tried, tried };
}

/**
 * One add-audio journey; the run owns every try, so ADD_AUDIO_MAX_TRIES and
 * ADD_AUDIO_TOTAL_MS hold across continuations whatever the caller does.
 * attempt() tries the next donors and records them all. After a 200 that the
 * device then fails to play, call attempt() again: it never repeats a donor.
 * Outcomes: {donor, result} | {failed} (spent, show noWorkingAudio) | {cancelled:true}.
 * I2: a donor is recorded the moment its try starts, and a second attempt()
 * while one is in flight gets the same promise, so concurrent calls never
 * exceed the cap or repeat a donor.
 */
export function createAddAudioRun({ language, donors = [], startedAt = Date.now() }) {
  const tried = [];
  const pool = donors.slice(0, ADD_AUDIO_MAX_TRIES);
  const record = donor => { if (donor && !tried.some(d => d.id === donor.id)) tried.push(donor); };
  const next = (nowMs = Date.now()) => {
    const totalMs = ADD_AUDIO_TOTAL_MS - (nowMs - startedAt);
    const left = pool.filter(d => !tried.some(t => t.id === d.id))
      .slice(0, Math.max(0, ADD_AUDIO_MAX_TRIES - tried.length));
    if (totalMs <= 0 || !left.length) return null;
    return { donors: left, totalMs, first: tried.length + 1, total: tried.length + left.length };
  };
  let inFlight = null;
  async function run({ tryOne, onTry, signal, now = Date.now, tryMs = ADD_AUDIO_TRY_MS }) {
    if (signal?.aborted) return { cancelled: true };
    const step = next(now());
    if (!step) return { failed: [...tried] };
    const claim = (donor, n, total) => { record(donor); onTry?.(donor, n, total); };
    const out = await tryDonors({ ...step, tryOne, onTry: claim, signal, now, tryMs });
    out.tried.forEach(record);
    if (out.cancelled) return { cancelled: true };
    if (out.donor) return { donor: out.donor, result: out.result };
    return { failed: [...tried] };
  }
  return {
    language,
    startedAt,
    tried,
    record,
    next,
    attempt(opts = {}) {
      if (!inFlight) inFlight = run(opts).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
