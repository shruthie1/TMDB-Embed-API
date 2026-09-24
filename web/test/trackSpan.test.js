import { describe, it, expect } from 'vitest';
import { trackSpanMin } from '../lib/subtitles';

/**
 * How long a subtitle file actually runs, used to reject a track timed for a
 * different cut of the film. Getting it wrong is silent in both directions: too
 * low and a good track is discarded with "no usable subtitle for this release",
 * too high and captions drift out of sync by the final act.
 */
const cue = (h, m, s = '00') => `${h}:${m}:${s}.000 --> ${h}:${m}:${s}.500\ntext\n\n`;

describe('trackSpanMin', () => {
  it('takes the LATEST cue, not the last one written', () => {
    // The bug. Measured on tt0330373 (Goblet of Fire): file 191411 ends with a
    // cue at 01:11 while its true final line sits at 01:51, cue 274 of 412.
    // Reading the last entry measured 71 minutes instead of 111 - a 40-minute
    // undercount that rejected the track.
    const outOfOrder = cue('00', '05') + cue('01', '51') + cue('01', '11');
    expect(trackSpanMin(outOfOrder)).toBe(111);
  });

  it('reads an ordinary ordered file correctly', () => {
    expect(trackSpanMin(cue('00', '02') + cue('01', '30') + cue('02', '37'))).toBe(157);
  });

  it('handles a film running past ten hours', () => {
    // `\\d{2}` would not match a 3-digit hour at all, so the whole file scored
    // zero and skipped the check entirely rather than failing it.
    expect(trackSpanMin(cue('100', '30'))).toBe(6030);
  });

  it('accepts both srt and vtt timestamp separators', () => {
    // srtToVtt runs first, but a file may already be vtt with a dot.
    expect(trackSpanMin('00:45:00,000 --> 00:45:02,000\nx\n')).toBe(45);
    expect(trackSpanMin('00:45:00.000 --> 00:45:02.000\nx\n')).toBe(45);
  });

  it('returns 0 when there is nothing to measure, so the check is skipped', () => {
    // 0 is falsy, and loadTrack guards on `if (span && ...)` - an unmeasurable
    // file is allowed through rather than rejected on no evidence.
    for (const junk of ['', 'WEBVTT\n\nno timestamps here', null, undefined]) {
      expect(trackSpanMin(junk), String(junk)).toBe(0);
    }
  });
});
