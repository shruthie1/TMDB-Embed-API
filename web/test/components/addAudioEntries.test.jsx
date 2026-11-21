import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { Copy } from '../../lib/player/loadingModel';

// Step 2 Task 4: "Add <L> audio from another server" entries. One per
// language the playing stream lacks, Telugu first, in their own group, on
// desktop, phone width (same components) and the Fire TV bar.

let compact = false;
window.matchMedia = (q) => ({
  matches: compact, media: q,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
vi.mock('../../components/Icon', () => ({ default: () => null }));
const { default: PlayerControls } = await import('../../components/PlayerControls');
const { default: TvBar } = await import('../../components/player/TvBar');

afterEach(() => { cleanup(); compact = false; });

const row = (id, provider, languages, extra = {}) => ({
  id, provider, quality: '720p', masterUrl: `http://x/${id}.m3u8`, levels: [{ height: 720 }],
  languages, selectableAudio: true, ...extra,
});
// Playing: showsst, Hindi only. CastleTV lends Hindi + Telugu.
const SHOWSST = row('showsst-3', 'showsst', ['Hindi'], { selectableAudio: false });
const CASTLE = row('CastleTV-0', 'CastleTV', ['Hindi', 'Telugu']);
const HINDI_TRACKS = [{ id: 0, name: 'Hindi' }];

function controls({ sources = [SHOWSST, CASTLE], tracks = HINDI_TRACKS, currentSourceId = 'showsst-3', ...rest } = {}) {
  const onAddAudio = vi.fn();
  const onPickLanguage = vi.fn();
  const onPickPair = vi.fn();
  const video = document.createElement('video');
  Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
  const view = render(
    <PlayerControls videoRef={{ current: video }} title="RRR" visible
                    sources={sources} audioSources={sources}
                    currentSource="showsst" currentSourceId={currentSourceId}
                    levels={[]} currentLevel={-1} subs={[]} currentSub={null}
                    audioTracks={tracks} currentAudio={0}
                    onPickLanguage={onPickLanguage} onPickPair={onPickPair}
                    onAddAudio={onAddAudio} {...rest} />,
  );
  fireEvent.click(view.container.querySelector('[aria-label^="Audio language"]'));
  return { view, menu: view.container.querySelector('.pmenu'), onAddAudio, onPickLanguage, onPickPair };
}

function tv({ sources = [SHOWSST, CASTLE], tracks = [], ...rest } = {}) {
  const onAddAudio = vi.fn();
  const onPickLanguage = vi.fn();
  const view = render(<TvBar sources={sources} audioSources={sources} currentSource="showsst"
                             currentSourceId="showsst-3" audioTracks={tracks} currentAudio={0}
                             onPickLanguage={onPickLanguage} onAddAudio={onAddAudio} {...rest} />);
  return { view, onAddAudio, onPickLanguage };
}

describe.each([['desktop', false], ['phone', true]])('%s audio menu', (_n, narrow) => {
  it('(e) offers Add Telugu when the playing stream lacks it; a tap calls onAddAudio only', () => {
    compact = narrow;
    const { menu, onAddAudio, onPickLanguage, onPickPair } = controls();
    const entry = within(menu).getByText('Add Telugu audio from another server');
    expect(within(menu).getByText(Copy.ADD_AUDIO_GROUP)).toBeTruthy();
    fireEvent.click(entry);
    expect(onAddAudio).toHaveBeenCalledWith('Telugu');
    expect(onPickLanguage).not.toHaveBeenCalled();
    expect(onPickPair).not.toHaveBeenCalled();
  });

  it('(e) no entry for a language the playing stream carries', () => {
    compact = narrow;
    const { menu } = controls();
    expect(within(menu).queryByText('Add Hindi audio from another server')).toBeNull();
  });

  it('a plain language pick never calls onAddAudio', () => {
    compact = narrow;
    const { menu, onAddAudio, onPickLanguage } = controls();
    // The plain Telugu row (not the add entry) is a plain pick.
    fireEvent.click(within(menu).getByText('Telugu'));
    expect(onPickLanguage).toHaveBeenCalledWith('Telugu');
    expect(onAddAudio).not.toHaveBeenCalled();
  });

  it('(e2) four missing languages: four entries, Telugu first, after the plain rows', () => {
    compact = narrow;
    const many = row('mapple-1', 'mapple', ['Tamil', 'Kannada', 'Malayalam', 'Telugu']);
    const { menu } = controls({ sources: [SHOWSST, many] });
    const texts = [...menu.querySelectorAll('.pmenu-group, .pmenu-text')]
      .map(el => el.textContent.trim()).filter(Boolean);
    const adds = texts.filter(t => t !== Copy.ADD_AUDIO_GROUP && t.startsWith('Add ') && t.endsWith('from another server'));
    expect(adds).toHaveLength(4);
    expect(adds[0]).toBe('Add Telugu audio from another server');
    // The group heading comes before every entry, and every plain row before it.
    const head = texts.indexOf(Copy.ADD_AUDIO_GROUP);
    expect(head).toBeGreaterThan(-1);
    expect(texts.indexOf(adds[0])).toBeGreaterThan(head);
    expect(texts.indexOf('Tamil')).toBeLessThan(head);
  });

  it('during a pair the video half is the playing row (pair id is no row)', () => {
    compact = narrow;
    // Playing pair: showsst picture + CastleTV Telugu. Tracks say Hindi+Telugu.
    const mapple = row('mapple-1', 'mapple', ['Tamil']);
    const { menu } = controls({
      sources: [SHOWSST, CASTLE, mapple], currentSourceId: 'pair-showsst-3-CastleTV-0',
      tracks: [{ id: 0, name: 'Hindi' }, { id: 1, name: 'Telugu' }],
    });
    expect(within(menu).getByText('Add Tamil audio from another server')).toBeTruthy();
    expect(within(menu).queryByText('Add Telugu audio from another server')).toBeNull();
  });

  it('without onAddAudio there is no group', () => {
    compact = narrow;
    const { menu } = controls({ onAddAudio: undefined });
    expect(within(menu).queryByText(Copy.ADD_AUDIO_GROUP)).toBeNull();
  });
});

describe('TV bar', () => {
  it('(e) offers Add Telugu in .tvbar-add; OK on it calls onAddAudio only', () => {
    const { view, onAddAudio, onPickLanguage } = tv();
    const box = view.container.querySelector('.tvbar-row .tvbar-btns.tvbar-add');
    expect(box).toBeTruthy();
    const btn = within(box).getByRole('button', { name: 'Add Telugu audio from another server' });
    expect(btn.className).toMatch(/tvbar-btn/);
    expect(btn.className).toMatch(/focusable/);
    fireEvent.click(btn);
    expect(onAddAudio).toHaveBeenCalledWith('Telugu');
    expect(onPickLanguage).not.toHaveBeenCalled();
  });

  it('(e) native path, no tracks: the playing row carries Hindi, so no Hindi entry', () => {
    const { view } = tv();
    expect(within(view.container).queryByRole('button', { name: 'Add Hindi audio from another server' })).toBeNull();
  });

  it('(e) a pair carries its donor languages (playingLanguages)', () => {
    const { view } = tv({ playingLanguages: ['Hindi', 'Telugu'] });
    expect(view.container.querySelector('.tvbar-add')).toBeNull();
  });

  it('(e2) four missing languages: four buttons inside .tvbar-add, Telugu first', () => {
    const many = row('mapple-1', 'mapple', ['Tamil', 'Kannada', 'Malayalam', 'Telugu']);
    const { view } = tv({ sources: [SHOWSST, many] });
    const box = view.container.querySelector('.tvbar-add');
    const names = [...box.querySelectorAll('button')].map(b => b.textContent.trim());
    expect(names).toHaveLength(4);
    expect(names[0]).toBe('Add Telugu audio from another server');
  });

  it('the .tvbar-add list scrolls; new CSS uses no gap, :has() or min()', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = css.match(/[^{}]*\.tvbar-add[^{}]*\{[^}]*\}/g) || [];
    expect(rules.length).toBeGreaterThan(0);
    const all = rules.join('\n');
    expect(all).toMatch(/max-height:/);
    expect(all).toMatch(/overflow-y:\s*auto/);
    expect(all).not.toMatch(/(^|[;{\s])gap\s*:|:has\(|min\(/);
  });
});
