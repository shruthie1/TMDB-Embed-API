import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Owner rule (2026-11-21, Task 5): a plain language pick switches the track or
// the server and never pairs, on desktop, phone and TV. Pairing stays a
// separate, explicit journey. These tests guard every web surface.

let compact = false;
window.matchMedia = (q) => ({
  matches: compact, media: q,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
vi.mock('../../components/Icon', () => ({ default: () => null }));
const { default: PlayerControls } = await import('../../components/PlayerControls');
const { default: TvBar } = await import('../../components/player/TvBar');

afterEach(() => { cleanup(); compact = false; });

// Playing: showsst 1080p with Hindi in-stream. CastleTV carries Telugu and
// Tamil as renditions in one master: the old model called that `pairable`.
const SHOWSST = {
  id: 'showsst-3', provider: 'showsst', quality: '1080p', masterUrl: 'http://x/ss.m3u8',
  levels: [{ height: 1080 }], languages: ['Hindi'], selectableAudio: false,
};
const CASTLE = {
  id: 'CastleTV-0', provider: 'CastleTV', quality: '720p', masterUrl: 'http://x/cd.m3u8',
  levels: [{ height: 720 }], languages: ['Telugu', 'Tamil'], selectableAudio: true,
  audio: [{ language: 'Telugu', languageCode: 'te', name: 'Telugu', uri: 't' },
          { language: 'Tamil', languageCode: 'ta', name: 'Tamil', uri: 'm' }],
};
const SOURCES = [SHOWSST, CASTLE];
const TRACKS = [{ id: 0, name: 'Hindi' }];

function mountControls(tracks = TRACKS) {
  const onPickLanguage = vi.fn();
  const onPickPair = vi.fn();
  const onPickSource = vi.fn();
  const video = document.createElement('video');
  Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
  const view = render(
    <PlayerControls videoRef={{ current: video }} title="RRR" visible
                    sources={SOURCES} audioSources={SOURCES}
                    currentSource="showsst" currentSourceId="showsst-3"
                    levels={[]} currentLevel={-1} subs={[]} currentSub={null}
                    audioTracks={tracks} currentAudio={0}
                    onPickLanguage={onPickLanguage} onPickPair={onPickPair}
                    onPickSource={onPickSource} />,
  );
  fireEvent.click(view.container.querySelector('[aria-label^="Audio language"]'));
  return { view, onPickLanguage, onPickPair, onPickSource };
}

describe.each([['desktop', false], ['mobile', true]])('%s audio menu', (_name, narrow) => {
  it('(b) a language another server carries is a plain pick, never a pair', () => {
    compact = narrow;
    const { view, onPickLanguage, onPickPair } = mountControls();
    fireEvent.click(within(view.container.querySelector('.pmenu')).getByText('Telugu'));
    expect(onPickLanguage).toHaveBeenCalledWith('Telugu');
    expect(onPickPair).not.toHaveBeenCalled();
  });

  it('(a) a language in the playing stream is a plain pick, never a pair', () => {
    compact = narrow;
    // Hindi is playing; Malayalam is a second track in the same stream.
    const { view, onPickLanguage, onPickPair } = mountControls([...TRACKS, { id: 1, name: 'Malayalam' }]);
    fireEvent.click(within(view.container.querySelector('.pmenu')).getByText('Malayalam'));
    expect(onPickLanguage).toHaveBeenCalledWith('Malayalam');
    expect(onPickPair).not.toHaveBeenCalled();
  });

  it('(c) a language no server carries is not offered', () => {
    compact = narrow;
    const { view } = mountControls();
    expect(within(view.container.querySelector('.pmenu')).queryByText('Kannada')).toBeNull();
  });
});

describe('TV language row', () => {
  const row = () => [...document.querySelectorAll('.tvbar-k')]
    .find((el) => el.textContent.trim() === 'Audio')?.parentElement;

  it('(b) a language another server carries goes to onPickLanguage, not a source or pair', () => {
    const onPickLanguage = vi.fn();
    const onPickSource = vi.fn();
    const onPickAudio = vi.fn();
    render(<TvBar sources={SOURCES} audioSources={SOURCES} currentSource="showsst"
                  currentSourceId="showsst-3" audioTracks={TRACKS} currentAudio={0}
                  onPickLanguage={onPickLanguage} onPickSource={onPickSource}
                  onPickAudio={onPickAudio} />);
    fireEvent.click(within(row()).getByRole('button', { name: 'Telugu' }));
    expect(onPickLanguage).toHaveBeenCalledWith('Telugu');
    expect(onPickSource).not.toHaveBeenCalled();
  });

  it('(c) a language no server carries is not offered', () => {
    render(<TvBar sources={SOURCES} audioSources={SOURCES} currentSource="showsst"
                  currentSourceId="showsst-3" audioTracks={TRACKS} currentAudio={0}
                  onPickLanguage={vi.fn()} />);
    expect(within(row()).queryByRole('button', { name: 'Kannada' })).toBeNull();
  });
});

// No test mounts Player.jsx (hls.js, resolve, recovery, a video element), so
// the shared decision is guarded in the source text, like switchNoAutoPair.
describe('Player wiring', () => {
  const text = readFileSync(resolve(__dirname, '../../components/Player.jsx'), 'utf8');
  const start = text.indexOf('const pickLanguage = useCallback(');
  const body = text.slice(start, text.indexOf('}, [', start));

  it('pickLanguage switches track or server and never pairs', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/hls\.pickAudio\(/);
    expect(body).toMatch(/languageSwitchCandidates\(/);
    expect(body).toMatch(/pickSource\(next, language/);
    expect(body).not.toMatch(/switchSource\(/);
    expect(body).not.toMatch(/pickPair|pairSources|pairingFor/);
  });

  // Concern 4 (2026-11-21): a failed language switch must go back to the
  // previous server and position exactly like a failed manual server pick,
  // through the same switchGuard, not a second restore path.
  it('the server branch goes through pickSource, which arms switchGuard.begin', () => {
    const ps = text.indexOf('const pickSource = useCallback(');
    const psBody = text.slice(ps, text.indexOf('}, [', ps));
    expect(ps).toBeGreaterThan(-1);
    expect(psBody).toMatch(/switchGuard\.begin\(snapshot\(\), rowLabel\(/);
    expect(psBody).toMatch(/return switchSource\(src, lang, opts\)/);
    // Declared after pickSource, so its dependency array can name it.
    expect(start).toBeGreaterThan(ps);
    expect(text.slice(text.indexOf('}, [', start), text.indexOf(']);', start))).toMatch(/\bpickSource\b/);
  });

  it('both surfaces get pickLanguage, so the legacy pair branch is never reached', () => {
    const wired = text.match(/onPickLanguage=\{pickLanguage\}/g) || [];
    expect(wired).toHaveLength(2);
    expect((text.match(/<TvBar\b/g) || [])).toHaveLength(1);
    expect((text.match(/<PlayerControls\b/g) || [])).toHaveLength(1);
  });
});
