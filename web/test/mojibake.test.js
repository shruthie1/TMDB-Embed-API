import { describe, it, expect } from 'vitest';
import { fixMojibake } from '../lib/subtitles';

// Build the corrupted forms from escapes: these are UTF-8 bytes that were
// decoded once as Windows-1252, which is exactly what the bad files contain.
const ELLIPSIS = '\u00e2\u20ac\u00a6';        // \u2026 mis-decoded
const LQUOTE   = '\u00e2\u20ac\u009c';        // \u201c mis-decoded
const APOS     = '\u00e2\u20ac\u2122';        // \u2019 mis-decoded

describe('fixMojibake', () => {
  it('repairs the caption the viewer reported', () => {
    // Seen on screen as "He proposed" followed by three stray glyphs.
    expect(fixMojibake('He proposed' + ELLIPSIS)).toBe('He proposed\u2026');
  });

  it('repairs curly quotes and apostrophes', () => {
    expect(fixMojibake(LQUOTE + 'Hello' + LQUOTE)).toBe('\u201cHello\u201c');
    expect(fixMojibake('it' + APOS + 's')).toBe('it\u2019s');
  });

  it('leaves text that is already correct completely alone', () => {
    // The safety property: this must never damage a good track.
    for (const good of ['He proposed\u2026', 'Caf\u00e9', '\u0c28\u0c2e\u0c38\u0c4d',
                        'plain ascii', '', 'a\u2019b \u201cc\u201d']) {
      expect(fixMojibake(good)).toBe(good);
    }
  });

  it('repairs line by line, so one bad byte cannot veto the whole file', () => {
    // Measured on a real 176KB track: a SINGLE invalid byte made a whole-file
    // round-trip throw, leaving all 91 corrupted lines untouched. Only the
    // undecodable line may be skipped.
    const undecodable = '\u00e2\u00e2';           // not a valid utf-8 sequence
    const src = ['He proposed' + ELLIPSIS, undecodable, 'Who' + ELLIPSIS].join('\n');
    const out = fixMojibake(src).split('\n');
    expect(out[0]).toBe('He proposed\u2026');
    expect(out[2]).toBe('Who\u2026');
    expect(out[1]).toBe(undecodable);            // kept verbatim, not mangled
  });

  it('preserves line endings and length for a clean file', () => {
    const src = '1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n';
    expect(fixMojibake(src)).toBe(src);
  });

  it('repairs a line the re-encoder guessed as Windows-1250', () => {
    // OpenSubtitles' utf8 re-encoder sometimes picks cp1250: the music note
    // E2 99 AA comes back as U+00E2 U+2122 U+015E. U+015E is not in cp1252.
    expect(fixMojibake('â™Ş La la â™Ş')).toBe('♪ La la ♪');
  });

  it('repairs a cp1250 line whose lead char is outside the cp1252 range', () => {
    // \u015b (C5 9B) read as cp1250 is U+0139 U+203A; seen in a live track.
    expect(fixMojibake('-(sanskrit \u0139\u203aloka chanting)')).toBe('-(sanskrit \u015bloka chanting)');
  });

  it('keeps an already-correct accented line under the cp1250 retry', () => {
    expect(fixMojibake('café Şule')).toBe('café Şule');
  });
});
