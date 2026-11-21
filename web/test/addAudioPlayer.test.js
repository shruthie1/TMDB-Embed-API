import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pairSources } from '../lib/backend';
import { Copy } from '../lib/player/loadingModel';
import { createAddAudioJourney, makeCheckPair, pairedStream, resumePoint, streamKey } from '../components/player/addAudioJourney';

// Step 2 Task 4: the explicit "Add <L> audio from another server" journey.
// Player.jsx is not mounted (hls.js, resolve, recovery), so the journey runs
// against a small fake player that holds the same state Player restores.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const PLAYING = { id: 'showsst-3', provider: 'showsst', masterUrl: 'http://x/ss.m3u8', languages: ['Telugu'] };
const D1 = { id: 'castle-0', provider: 'CastleTV', masterUrl: 'http://x/c.m3u8', languages: ['Hindi'] };
const D2 = { id: 'mapple-1', provider: 'mapple', masterUrl: 'http://x/m.m3u8', languages: ['Hindi'] };
const D3 = { id: 'vidrock-2', provider: 'vidrock', masterUrl: 'http://x/v.m3u8', languages: ['Hindi'] };
const flush = () => new Promise(r => setTimeout(r, 0));

/**
 * A fake player: the state a failed journey must leave unchanged. Like
 * Player.jsx it reports every stream change to the journey (streamChanged).
 */
function fakePlayer({ pairSources: pair, pairDecodable = () => true }) {
  const state = { currentSourceId: PLAYING.id, stream: PLAYING, wantLang: 'Telugu', notice: null };
  const videoRef = { current: { currentTime: 1234, readyState: 4 } };
  let journey;
  const show = (src) => {
    state.stream = src; state.currentSourceId = src.id;
    journey?.streamChanged(streamKey(src));
  };
  // A new stream starts loading: no metadata, position 0.
  const switchSource = vi.fn((src) => { show(src); videoRef.current.currentTime = 0; videoRef.current.readyState = 0; });
  const timers = [];
  journey = createAddAudioJourney({
    checkPair: makeCheckPair({ pairSources: pair, pairDecodable, tmdbId: 1, mediaType: 'movie' }),
    // Like Player.applyPair: the resume point is read before the switch.
    applyPair: (video, donor, language, paired, at) => {
      state.resumeAt = resumePoint(videoRef.current, at);
      state.wantLang = language;
      switchSource(pairedStream(video, donor, paired));
    },
    snapshot: () => {
      const stream = { ...state.stream, id: state.currentSourceId, at: videoRef.current.currentTime };
      return { key: streamKey(stream), at: stream.at, stream, wantLang: state.wantLang };
    },
    restore: (snap) => {
      show(snap.stream);
      videoRef.current.currentTime = snap.stream.at; state.wantLang = snap.wantLang;
    },
    notice: (t) => { state.notice = t; },
    position: () => resumePoint(videoRef.current),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  journey.streamChanged(streamKey(PLAYING));
  const addAudio = (language, donors = [D1, D2, D3]) => journey.start({ language, video: PLAYING, donors });
  const onOriginal = () => {
    expect(state.currentSourceId).toBe('showsst-3');
    expect(state.stream.masterUrl).toBe(PLAYING.masterUrl);
    expect(videoRef.current.currentTime).toBe(1234);
    expect(state.wantLang).toBe('Telugu');
  };
  // Another server took over (failover, stall recovery, a pick).
  const foreign = (src = { id: 'vidrock-9', masterUrl: 'http://x/other.m3u8' }) => show(src);
  return { state, videoRef, switchSource, journey, addAudio, timers, onOriginal, foreign };
}
const OK = (v, a) => ({ url: `http://x/${a.id}.m3u8` });
const pairKey = (donor) => streamKey({ id: `pair-showsst-3-${donor.id}`, masterUrl: `http://x/${donor.id}.m3u8` });

describe('(a) pairSources sends the language', () => {
  it('posts language:Hindi', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ url: 'http://x/p.m3u8' }) }));
    vi.stubGlobal('fetch', fetch);
    await pairSources(PLAYING, D1, { language: 'Hindi' });
    expect(JSON.parse(fetch.mock.calls[0][1].body).language).toBe('Hindi');
  });

  it('a 409 not pairable is null (try the next donor)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ reason: 'not pairable' }) })));
    expect(await pairSources(PLAYING, D1, { language: 'Hindi' })).toBeNull();
  });
});

describe('Player addAudio journey', () => {
  it('(b) every donor refused: nothing changes, noWorkingAudio shown', async () => {
    const p = fakePlayer({ pairSources: vi.fn(async () => null) });
    const out = await p.addAudio('Hindi');
    expect(out.failed).toHaveLength(3);
    expect(p.state.wantLang).toBe('Telugu');
    expect(p.state.currentSourceId).toBe('showsst-3');
    expect(p.videoRef.current.currentTime).toBe(1234);
    expect(p.switchSource).not.toHaveBeenCalled();
    expect(p.state.notice).toBe('No server has working Hindi audio. Playback is unchanged.');
  });

  it('(c) second donor passes: one switch to the pair master, hybrid', async () => {
    const pair = vi.fn(async (v, a, opts) => {
      expect(opts.language).toBe('Hindi');
      return a.id === 'mapple-1' ? { url: 'http://x/pair.m3u8', codecs: null } : null;
    });
    const p = fakePlayer({ pairSources: pair });
    await p.addAudio('Hindi');
    expect(p.switchSource).toHaveBeenCalledTimes(1);
    expect(p.switchSource.mock.calls[0][0]).toMatchObject({ masterUrl: 'http://x/pair.m3u8', hybrid: true, id: 'pair-showsst-3-mapple-1' });
    expect(p.state.wantLang).toBe('Hindi');
  });

  it('(d) pairDecodable false counts as a failed try', async () => {
    const p = fakePlayer({
      pairSources: vi.fn(async (v, a) => ({ url: `http://x/${a.id}.m3u8`, codecs: { audio: a.id === 'castle-0' ? 'ac-3' : 'mp4a' } })),
      pairDecodable: (c) => c.audio !== 'ac-3',
    });
    await p.addAudio('Hindi');
    expect(p.switchSource).toHaveBeenCalledTimes(1);
    expect(p.switchSource.mock.calls[0][0].masterUrl).toBe('http://x/mapple-1.m3u8');
  });

  it('shows checkingAudio per try, n of total', async () => {
    const notices = [];
    const p = fakePlayer({ pairSources: vi.fn(async () => null) });
    const orig = p.state;
    Object.defineProperty(orig, 'notice', { set: (t) => notices.push(t), get: () => notices.at(-1) });
    await p.addAudio('Hindi');
    expect(notices.slice(0, 3)).toEqual([
      Copy.checkingAudio('Hindi', 'CastleTV', 1, 3),
      Copy.checkingAudio('Hindi', 'mapple', 2, 3),
      Copy.checkingAudio('Hindi', 'vidrock', 3, 3),
    ]);
  });

  it('(e3) ruling: a pair that fails on the device is put back AT ONCE, the run checks on', async () => {
    let release;
    const pair = vi.fn((v, a) => (a.id === 'castle-0' ? Promise.resolve(OK(v, a)) : new Promise(r => { release = () => r(OK(v, a)); })));
    const p = fakePlayer({ pairSources: pair });
    await p.addAudio('Hindi');
    expect(p.state.currentSourceId).toBe('pair-showsst-3-castle-0');
    expect(p.journey.deviceFailed()).toBe(true);   // onFatal
    // Back on the stream from before the run while mapple is checked.
    p.onOriginal();
    await flush();
    expect(p.journey.running()).toBe(true);
    expect(p.state.notice).toBe(Copy.checkingAudio('Hindi', 'mapple', 2, 3));
    release();
    await flush();
    expect(p.state.currentSourceId).toBe('pair-showsst-3-mapple-1');
    // Lands: success copy replaces "Checking ...".
    expect(p.journey.landed(pairKey(D2))).toBe(true);
    expect(p.state.notice).toBe('Hindi audio added from mapple.');
    expect(p.journey.running()).toBe(false);
  });

  it('(e3b) no frame within the try time is a device failure too: restore, then next donor', async () => {
    const p = fakePlayer({ pairSources: vi.fn(async (v, a) => OK(v, a)) });
    await p.addAudio('Hindi');
    p.timers.at(-1)();
    expect(p.state.currentSourceId).toBe('showsst-3');
    await flush();
    expect(p.state.currentSourceId).toBe('pair-showsst-3-mapple-1');
  });

  it('(e4) all donors fail on the device: playback is the snapshot, notice noWorkingAudio only', async () => {
    const p = fakePlayer({ pairSources: vi.fn(async (v, a) => OK(v, a)) });
    await p.addAudio('Hindi');
    for (let i = 0; i < 3; i++) { p.journey.deviceFailed(); await flush(); }
    expect(p.journey.running()).toBe(false);
    p.onOriginal();
    expect(p.state.notice).toBe(Copy.noWorkingAudio('Hindi'));
    // Not handled once the run is over: onFatal goes its normal way.
    expect(p.journey.deviceFailed()).toBe(false);
  });

  it('(I2) a frame of the run\'s own pair: audioAdded replaces Checking, later fatals are not ours', async () => {
    const p = fakePlayer({ pairSources: vi.fn(async (v, a) => OK(v, a)) });
    await p.addAudio('Hindi');
    expect(p.state.notice).toBe(Copy.checkingAudio('Hindi', 'CastleTV', 1, 3));
    expect(p.journey.landed(pairKey(D1))).toBe(true);
    expect(p.state.notice).toBe(Copy.audioAdded('Hindi', 'CastleTV'));
    expect(p.journey.deviceFailed()).toBe(false);
    expect(p.journey.running()).toBe(false);
  });

  it('(I1) landed counts only the stream the run applied', async () => {
    const p = fakePlayer({ pairSources: vi.fn(async (v, a) => OK(v, a)) });
    await p.addAudio('Hindi');
    expect(p.journey.landed(streamKey(PLAYING))).toBe(false);
    expect(p.journey.landed('vidrock-9|http://x/other.m3u8')).toBe(false);
    expect(p.journey.running()).toBe(true);
  });

  it('(I1) a failover during a server check ends the run; the late 200 never applies', async () => {
    let release; let signal;
    const pair = vi.fn((v, a, opts) => { signal = opts.signal; return new Promise(r => { release = () => r(OK(v, a)); }); });
    const p = fakePlayer({ pairSources: pair });
    const out = p.addAudio('Hindi');
    await flush();
    p.foreign();
    expect(signal.aborted).toBe(true);
    expect(p.journey.running()).toBe(false);
    release();
    expect(await out).toEqual({ cancelled: true });
    expect(p.switchSource).not.toHaveBeenCalled();
    expect(p.state.currentSourceId).toBe('vidrock-9');
  });

  it('(I1) a stall-recovery switch while the pair loads ends the run; its frame is not a success', async () => {
    const p = fakePlayer({ pairSources: vi.fn(async (v, a) => OK(v, a)) });
    await p.addAudio('Hindi');
    p.foreign();
    expect(p.journey.running()).toBe(false);
    expect(p.journey.landed('vidrock-9|http://x/other.m3u8')).toBe(false);
    expect(p.journey.deviceFailed()).toBe(false);   // onFatal goes its normal way
    expect(p.state.notice).not.toBe(Copy.audioAdded('Hindi', 'CastleTV'));
  });

  it('(I1) a foreign change after a restore, while the next donor is checked, ends the run', async () => {
    let release;
    const pair = vi.fn((v, a) => (a.id === 'castle-0' ? Promise.resolve(OK(v, a)) : new Promise(r => { release = () => r(OK(v, a)); })));
    const p = fakePlayer({ pairSources: pair });
    await p.addAudio('Hindi');
    p.journey.deviceFailed();
    await flush();
    p.foreign();
    release();
    await flush();
    expect(p.switchSource).toHaveBeenCalledTimes(1);
    expect(p.state.currentSourceId).toBe('vidrock-9');
    expect(p.journey.running()).toBe(false);
  });

  it('(I1) the run\'s own applyPair and restore do not end it', async () => {
    const p = fakePlayer({ pairSources: vi.fn(async (v, a) => OK(v, a)) });
    await p.addAudio('Hindi');
    expect(p.journey.running()).toBe(true);
    p.journey.deviceFailed();
    expect(p.journey.running()).toBe(true);
    await flush();
    expect(p.journey.running()).toBe(true);
    expect(p.state.currentSourceId).toBe('pair-showsst-3-mapple-1');
  });

  it('(RI1) a donor that wins before the restored stream loads resumes at the snapshot position, not 0', async () => {
    let release;
    const pair = vi.fn((v, a) => (a.id === 'castle-0' ? Promise.resolve(OK(v, a)) : new Promise(r => { release = () => r(OK(v, a)); })));
    const p = fakePlayer({ pairSources: pair });
    await p.addAudio('Hindi');
    expect(p.state.resumeAt).toBe(1234);           // first pair: live position at the tap
    p.journey.deviceFailed();                      // restore to showsst at 1234
    // The restored stream is still loading: no metadata, reads 0.
    p.videoRef.current.currentTime = 0; p.videoRef.current.readyState = 0;
    await flush();
    release();
    await flush();
    expect(p.state.currentSourceId).toBe('pair-showsst-3-mapple-1');
    expect(p.state.resumeAt).toBe(1234);
  });

  it('(RI1) resumePoint: live time only with metadata and past 0', () => {
    expect(resumePoint({ readyState: 1, currentTime: 50 }, 10)).toBe(50);
    expect(resumePoint({ readyState: 0, currentTime: 50 }, 10)).toBe(10);
    expect(resumePoint({ readyState: 4, currentTime: 0 }, 10)).toBe(10);
    expect(resumePoint(null, 10)).toBe(10);
    // No run position (a menu pair pick): the element's own value, as before.
    expect(resumePoint({ readyState: 0, currentTime: 7 })).toBe(7);
    expect(resumePoint(undefined)).toBe(0);
  });

  it('(M5) while a pair is unsettled, unsettled() is the pre-run snapshot; none after it lands', async () => {
    const p = fakePlayer({ pairSources: vi.fn(async (v, a) => OK(v, a)) });
    expect(p.journey.unsettled()).toBeNull();
    await p.addAudio('Hindi');
    expect(p.journey.unsettled().stream).toMatchObject({ id: 'showsst-3', at: 1234 });
    p.journey.landed(pairKey(D1));
    expect(p.journey.unsettled()).toBeNull();
  });

  it('a second tap on the same entry joins the run: notice only, no extra pair call', async () => {
    let release;
    const pair = vi.fn(() => new Promise(r => { release = r; }));
    const p = fakePlayer({ pairSources: pair });
    const first = p.addAudio('Hindi');
    await flush();
    const second = p.addAudio('Hindi');
    expect(p.state.notice).toBe(Copy.checkingAudio('Hindi', 'CastleTV', 1, 3));
    expect(pair).toHaveBeenCalledTimes(1);
    release({ url: 'http://x/p.m3u8' });
    expect(await second).toBe(await first);
    expect(p.switchSource).toHaveBeenCalledTimes(1);
  });

  it('cancel (unmount, title change, plain pick) aborts the try in flight and changes nothing', async () => {
    let signal;
    const pair = vi.fn((v, a, opts) => { signal = opts.signal; return new Promise(() => {}); });
    const p = fakePlayer({ pairSources: pair });
    const out = p.addAudio('Hindi');
    await flush();
    p.journey.cancel();
    expect(signal.aborted).toBe(true);
    expect(await out).toEqual({ cancelled: true });
    expect(p.switchSource).not.toHaveBeenCalled();
    expect(p.state.notice).toBe(Copy.checkingAudio('Hindi', 'CastleTV', 1, 3));
  });

  it('tapping another entry aborts the first run and starts the new language', async () => {
    const signals = [];
    const pair = vi.fn((v, a, opts) => { signals.push(opts); return opts.language === 'Tamil' ? Promise.resolve({ url: 'http://x/t.m3u8' }) : new Promise(() => {}); });
    const p = fakePlayer({ pairSources: pair });
    p.addAudio('Hindi');
    await flush();
    await p.addAudio('Tamil');
    expect(signals[0].signal.aborted).toBe(true);
    expect(p.state.wantLang).toBe('Tamil');
  });
});

// Player wiring, guarded in the source text like switchNoAutoPair.
describe('Player.jsx wiring', () => {
  const text = readFileSync(fileURLToPath(new URL('../components/Player.jsx', import.meta.url)), 'utf8');
  const body = (head) => {
    const start = text.indexOf(head);
    return start < 0 ? '' : text.slice(start, text.indexOf('}, [', start));
  };

  it('pickPair sets the wanted language only on success (in applyPair)', () => {
    const pickPair = body('const pickPair = useCallback(');
    const pairCall = pickPair.indexOf('await pairSources(');
    expect(pairCall).toBeGreaterThan(-1);
    // Before the pair call only the substitute branch may set it.
    const pairStart = pickPair.indexOf('const video = plan.video?.source;');
    expect(pairStart).toBeGreaterThan(-1);
    const before = pickPair.slice(pairStart, pairCall);
    expect(before).not.toMatch(/setWantLang/);
    expect(body('const applyPair = useCallback(')).toMatch(/setWantLang\(language\)/);
    expect(body('const applyPair = useCallback(')).toMatch(/lastPair\.current = /);
  });

  it('onFatal hands a journey pair to the journey first', () => {
    const fatal = body('const onFatal = useCallback(');
    const mine = fatal.indexOf('addAudioJourney.deviceFailed()');
    expect(mine).toBeGreaterThan(-1);
    expect(mine).toBeLessThan(fatal.indexOf('switchGuard.fail()'));
  });

  it('a frame ends the journey; unmount and title/episode change cancel it', () => {
    expect(text).toMatch(/addAudioJourney\.landed\(key\)/);
    expect(text).toMatch(/addAudioJourney\.streamChanged\(streamKey\(\{ id: currentSourceId, masterUrl: stream\?\.masterUrl \}\)\);\s*\n\s*\}, \[addAudioJourney, stream, currentSourceId\]\)/);
    expect(text).toMatch(/useEffect\(\(\) => \(\) => addAudioJourney\.cancel\(\), \[addAudioJourney\]\)/);
    expect(text).toMatch(/addAudioJourney\.cancel\(\);\s*\n\s*\}, \[addAudioJourney, title\.tmdbId, title\.mediaType, season, episode\]\)/);
  });

  it('plain picks cancel a run and never start one', () => {
    for (const head of ['const pickSource = useCallback(', 'const pickLanguage = useCallback(', 'const pickPairGuarded = useCallback(']) {
      const b = body(head);
      expect(b, head).toMatch(/addAudioJourney\.cancel\(\)/);
      expect(b, head).not.toMatch(/addAudioJourney\.start|addAudio\(/);
    }
  });

  // (f) Pairing never starts by itself: mounting, a server pick or a language
  // pick cannot reach /hybrid/pair. The journey starts in one place, addAudio,
  // and addAudio is only handed to the menus as onAddAudio.
  it('(f) the journey starts only from the menu entry', () => {
    expect(text.match(/addAudioJourney\.start\(/g) || []).toHaveLength(1);
    expect(body('const addAudio = useCallback(')).toMatch(/addAudioJourney\.start\(/);
    const uses = text.match(/\baddAudio\b(?!Journey|Deps|')/g) || [];
    // The definition, two onAddAudio props, nothing else.
    expect(uses).toHaveLength(3);
    // pairSources is called by pickPair, commitAudioSync, and handed to the
    // journey's checkPair; nowhere else.
    expect(text.match(/pairSources\(/g) || []).toHaveLength(2);
    expect(text.match(/makeCheckPair\(\{ pairSources/g) || []).toHaveLength(1);
  });

  it('(M5) a plain pick snapshots before it cancels the run; snapshot() prefers the pre-run stream', () => {
    for (const head of ['const pickSource = useCallback(', 'const pickPairGuarded = useCallback(']) {
      const b = body(head);
      expect(b.indexOf('switchGuard.begin(snapshot()'), head).toBeGreaterThan(-1);
      expect(b.indexOf('switchGuard.begin(snapshot()'), head).toBeLessThan(b.indexOf('addAudioJourney.cancel()'));
    }
    expect(text).toMatch(/const snapshot = useCallback\(\(\) => addAudioJourney\.unsettled\(\)\?\.stream \|\|/);
  });

  it('both surfaces get onAddAudio', () => {
    expect(text.match(/onAddAudio=\{addAudio\}/g) || []).toHaveLength(2);
  });
});
