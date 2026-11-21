import { describe, it, expect } from 'vitest';
import { displayAudioTracks } from '../lib/player/languageSources';

// multimovies and vidrift masters carry one rendition NAME="Audio", no LANGUAGE.
const TEL = { id: 'mm-0', provider: 'multimovies', languages: ['Telugu'] };

describe('displayAudioTracks: generic rendition names in the audio menu', () => {
  it('shows the row language for one unlabelled track, keeping id and lang', () => {
    const tracks = [{ id: 0, name: 'Audio', lang: null }];
    expect(displayAudioTracks(tracks, TEL)).toEqual([{ id: 0, name: 'Telugu', lang: null }]);
    expect(tracks[0].name).toBe('Audio');
  });

  it('leaves several unlabelled tracks as they are', () => {
    const tracks = [{ id: 0, name: 'Audio', lang: null }, { id: 1, name: 'Audio 2', lang: null }];
    expect(displayAudioTracks(tracks, TEL)).toBe(tracks);
  });

  it('leaves a track with a real language as it is', () => {
    const tracks = [{ id: 0, name: 'Hindi', lang: 'hi' }];
    expect(displayAudioTracks(tracks, TEL)).toBe(tracks);
  });

  it('leaves the track as it is when the row has no language', () => {
    const tracks = [{ id: 0, name: 'Audio', lang: null }];
    expect(displayAudioTracks(tracks, { languages: [] })).toBe(tracks);
    expect(displayAudioTracks(tracks, null)).toBe(tracks);
  });
});
