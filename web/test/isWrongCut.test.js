import { describe, it, expect } from 'vitest';
import { isWrongCut } from '../lib/subtitles';

/**
 * Hide files the LISTING already condemns, so the menu offers only tracks that
 * can plausibly play.
 *
 * Mistiming is otherwise only detectable after downloading, by which point the
 * viewer has clicked and waited. Measured on tt0330373 (Goblet of Fire), 7
 * English tracks: this hides 5 of the 6 mistimed ones and none of the usable
 * ones, taking the menu from 7 entries to 2.
 *
 * The filenames below are verbatim from that listing.
 */
describe('isWrongCut — hides what cannot match the feature', () => {
  it('rejects a subtitle split across discs', () => {
    // Half a film. These measured 65-111min against a 157min feature.
    for (const name of [
      'nedivx-hpgof-cd1.srt',
      'nedivx-hpgof-cd2.srt',
      'Harry.Potter.And.The.Goblet.Of.Fire.XViD.TS.CD2-maVen.srt',
    ]) {
      expect(isWrongCut({ subtitleFileName: name }), name).toBe(true);
    }
  });

  it('reads the release name too, not only the filename', () => {
    // CD2 appears in movieReleaseName for some entries and subtitleFileName
    // for others; checking one field alone misses half of them.
    expect(isWrongCut({ movieReleaseName: 'Harry.Potter.And.The.Goblet.Of.Fire.raVen.CD2' })).toBe(true);
  });

  it('rejects a camcorder or telecine source', () => {
    expect(isWrongCut({ releaseFormat: 'Telesync' })).toBe(true);
    expect(isWrongCut({ subtitleFileName: 'Harry.Potter.2005.CAM.XviD.srt' })).toBe(true);
    expect(isWrongCut({ releaseFormat: 'Cam' })).toBe(true);
  });

  it('KEEPS the file that actually works', () => {
    // The one usable track in that listing. Hiding a working subtitle is worse
    // than showing one that fails: a failure can be retried, an absent entry
    // cannot.
    expect(isWrongCut({
      subtitleFileName: 'Harry Potter and the Goblet of Fire - English.srt',
      movieReleaseName: 'Harry Potter and the Goblet of Fire',
    })).toBe(false);
  });

  it('keeps a DVD or web release, which is the normal case', () => {
    for (const s of [
      { subtitleFileName: 'Movie.2005.1080p.BluRay.x264.srt' },
      { subtitleFileName: 'Movie.2005.WEB-DL.srt', releaseFormat: 'DVD' },
      { movieReleaseName: 'Some Film (2005)' },
    ]) {
      expect(isWrongCut(s), JSON.stringify(s)).toBe(false);
    }
  });

  it('does not fire on the letters appearing inside a word', () => {
    // `TS` and `CAM` are short; matching them loosely would hide good files.
    // \b anchors mean CAMERA, ARTS and PARTS must not trip it.
    for (const name of [
      'The.Camera.Man.1928.srt',
      'Liberal.Arts.2012.srt',
      'Spare.Parts.2015.srt',
      'Discovery.2017.srt',        // contains "disc" but not "disc 1"
    ]) {
      expect(isWrongCut({ subtitleFileName: name }), name).toBe(false);
    }
  });

  it('survives an entry with no metadata at all', () => {
    expect(isWrongCut({})).toBe(false);
    expect(isWrongCut()).toBe(false);
  });
});
