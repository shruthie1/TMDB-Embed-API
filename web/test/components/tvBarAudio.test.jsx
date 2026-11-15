import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within, screen } from '@testing-library/react';
import TvBar from '../../components/player/TvBar';

afterEach(cleanup);

// movie/628241 as production returns it (verified 2026-09-24): CastleTV ships
// one stream PER language, so the languages live in sibling sources rather
// than in renditions inside one file.
const SOURCES = [
  { id: 'c-0', provider: 'CastleTV', languages: ['Telugu'], quality: '720p' },
  { id: 'c-1', provider: 'CastleTV', languages: ['Telugu'], quality: '480p' },
  { id: 's-0', provider: 'showsst', languages: [], quality: '1080p' },
  { id: 'c-2', provider: 'CastleTV', languages: ['Malayalam'], quality: '720p' },
  { id: 'c-3', provider: 'CastleTV', languages: ['Hindi'], quality: '480p' },
];

const row = (name) => {
  const k = [...document.querySelectorAll('.tvbar-k')].find(
    (el) => el.textContent.trim() === name);
  return k ? k.parentElement : null;
};

describe('TvBar audio row (Fire TV / Silk native path)', () => {
  // The regression: Silk plays in its own native player, which has no
  // audio-track menu, and TvBar rendered no audio control - so a Telugu-first
  // library had no way to choose Telugu on a TV.
  it('offers a language row even though hls.js never attached', () => {
    render(<TvBar sources={SOURCES} currentSource="CastleTV" currentSourceId="c-0"
                  audioTracks={[]} currentAudio={undefined} />);
    const audio = row('Audio');
    expect(audio).not.toBeNull();
    const names = [...within(audio).getAllByRole('button')].map((b) => b.textContent);
    expect(names).toEqual(['Telugu', 'Malayalam', 'Hindi']);
  });

  it('marks the language that is playing', () => {
    render(<TvBar sources={SOURCES} currentSource="CastleTV" currentSourceId="c-0"
                  audioTracks={[]} />);
    const btn = within(row('Audio')).getByRole('button', { name: 'Telugu' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('switching language hands back the SOURCE OBJECT, not an id', () => {
    // onPickSource takes a source; passing the id silently did nothing.
    const onPickSource = vi.fn();
    render(<TvBar sources={SOURCES} currentSource="CastleTV" currentSourceId="c-0"
                  audioTracks={[]} onPickSource={onPickSource} />);
    fireEvent.click(within(row('Audio')).getByRole('button', { name: 'Malayalam' }));
    expect(onPickSource).toHaveBeenCalledTimes(1);
    const [src, lang] = onPickSource.mock.calls[0];
    expect(src).toMatchObject({ id: 'c-2', languages: ['Malayalam'] });
    expect(lang).toBe('Malayalam');
  });

  it('prefers an in-file track switch when the file really has renditions', () => {
    const onPickAudio = vi.fn(() => true);
    const onPickSource = vi.fn();
    const tracks = [{ id: 0, name: 'Telugu' }, { id: 1, name: 'Hindi' }];
    render(<TvBar sources={[SOURCES[0]]} currentSource="CastleTV" currentSourceId="c-0"
                  audioTracks={tracks} currentAudio={0}
                  onPickAudio={onPickAudio} onPickSource={onPickSource} />);
    fireEvent.click(within(row('Audio')).getByRole('button', { name: 'Hindi' }));
    expect(onPickAudio).toHaveBeenCalledWith(1);
    // Switching in place keeps the playback position, so no source change.
    expect(onPickSource).not.toHaveBeenCalled();
  });

  it('falls through to a source switch when pickAudio refuses the id', () => {
    // pickAudio returns false for an id that is not an hls track index.
    const onPickAudio = vi.fn(() => false);
    const onPickSource = vi.fn();
    render(<TvBar sources={SOURCES} currentSource="CastleTV" currentSourceId="c-0"
                  audioTracks={[]} onPickAudio={onPickAudio} onPickSource={onPickSource} />);
    fireEvent.click(within(row('Audio')).getByRole('button', { name: 'Hindi' }));
    expect(onPickSource).toHaveBeenCalledTimes(1);
    expect(onPickSource.mock.calls[0][0]).toMatchObject({ id: 'c-3' });
  });

  it('shows no audio row when there is nothing to choose', () => {
    // A dead control on a remote is worse than no control.
    render(<TvBar sources={[SOURCES[2]]} currentSource="showsst" currentSourceId="s-0"
                  audioTracks={[]} />);
    expect(row('Audio')).toBeNull();
  });

  // The Source row identified streams by PROVIDER, but CastleTV ships one
  // stream per language, so 628241 rendered five identical "CastleTV" buttons
  // and marked all five selected at once.
  it('marks only the stream that is playing, not every one of its provider', () => {
    render(<TvBar sources={SOURCES} currentSource="CastleTV" currentSourceId="c-0"
                  audioTracks={[]} />);
    const on = [...within(row('Source')).getAllByRole('button')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(on).toHaveLength(1);
    expect(on[0].textContent).toContain('Telugu');
  });

  it('distinguishes same-provider streams by language and quality', () => {
    render(<TvBar sources={SOURCES} currentSource="CastleTV" currentSourceId="c-0"
                  audioTracks={[]} />);
    const labels = [...within(row('Source')).getAllByRole('button')]
      .map((b) => b.textContent);
    // Five CastleTV entries must not all read the bare provider name.
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.some((l) => l.includes('Telugu') && l.includes('720p'))).toBe(true);
  });

  it('still renders the other rows', () => {
    render(<TvBar sources={SOURCES} currentSource="CastleTV" currentSourceId="c-0"
                  audioTracks={[]} />);
    expect(row('Source')).not.toBeNull();
    expect(row('Picture')).not.toBeNull();
  });
});
