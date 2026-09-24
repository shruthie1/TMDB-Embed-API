import { describe, it, expect } from 'vitest';
import { audioOptions } from '../lib/player/audioOptions';

// Shapes taken from the live API on 2026-09-21, not invented.
//   811941 Devara - one master, 4 muxed tracks.
//   770906 Salaar - 13 streams that are really 6 languages x 2 qualities.
const DEVARA_TRACKS = [
  { id: 0, name: 'Kannada' }, { id: 1, name: 'Malayalam' },
  { id: 2, name: 'Tamil' }, { id: 3, name: 'Telugu' },
];
const SALAAR_SOURCES = [
  { id: 'c-0', languages: ['Telugu'], quality: '720p' },
  { id: 'c-1', languages: ['Telugu'], quality: '480p' },
  { id: 'v-2', languages: [], quality: '1080p' },        // VaPlayer, untagged
  { id: 'c-3', languages: ['English'], quality: '720p' },
  { id: 'c-4', languages: ['Hindi'], quality: '720p' },
  { id: 'c-5', languages: ['Tamil'], quality: '720p' },
  { id: 'c-6', languages: ['Malayalam'], quality: '720p' },
  { id: 'c-7', languages: ['Kannada'], quality: '720p' },
  { id: 'c-8', languages: ['English'], quality: '480p' },
];

describe('audioOptions', () => {
  it('uses in-file tracks when the master really carries several', () => {
    const r = audioOptions({ audioTracks: DEVARA_TRACKS, currentAudio: 3 });
    expect(r.kind).toBe('muxed');
    expect(r.options.map(o => o.name)).toEqual(['Kannada', 'Malayalam', 'Tamil', 'Telugu']);
    expect(r.current).toBe(3);
  });

  it('offers per-language sibling streams when there is no multi-track file', () => {
    // The actual complaint: Telugu played, but switching to Hindi meant
    // opening Source and reading 13 near-identical rows.
    const r = audioOptions({ sources: SALAAR_SOURCES, currentSourceId: 'c-0' });
    expect(r.kind).toBe('sources');
    expect(r.options.map(o => o.name))
      .toEqual(['Telugu', 'English', 'Hindi', 'Tamil', 'Malayalam', 'Kannada']);
  });

  it('collapses several qualities of one language into a single entry', () => {
    const r = audioOptions({ sources: SALAAR_SOURCES, currentSourceId: 'c-0' });
    expect(r.options.filter(o => o.name === 'Telugu')).toHaveLength(1);
    expect(r.options.filter(o => o.name === 'English')).toHaveLength(1);
  });

  it('keeps the entry pointing at the file already playing', () => {
    // Opening the menu must not silently reassign which file "Telugu" means.
    const r = audioOptions({ sources: SALAAR_SOURCES, currentSourceId: 'c-1' });
    expect(r.current).toBe('c-1');
    expect(r.options.find(o => o.name === 'Telugu').id).toBe('c-1');
  });

  it('ignores a source that does not state exactly one language', () => {
    const r = audioOptions({ sources: SALAAR_SOURCES, currentSourceId: 'c-0' });
    expect(r.options.some(o => o.id === 'v-2')).toBe(false);
  });

  it('prefers the in-file switch when both exist', () => {
    // Switching inside one file keeps the playback position, so it wins.
    const r = audioOptions({
      audioTracks: DEVARA_TRACKS, currentAudio: 3,
      sources: SALAAR_SOURCES, currentSourceId: 'c-0',
    });
    expect(r.kind).toBe('muxed');
  });

  it('still reports a single language rather than hiding the control', () => {
    const r = audioOptions({ sources: [{ id: 'a', languages: ['Hindi'] }], currentSourceId: 'a' });
    expect(r.options.map(o => o.name)).toEqual(['Hindi']);
  });

  it('reports nothing when no language is known anywhere', () => {
    const r = audioOptions({ sources: [{ id: 'a', languages: [] }], currentSourceId: 'a' });
    expect(r.kind).toBe('none');
    expect(r.options).toEqual([]);
  });
});
