import { describe, it, expect } from 'vitest';
import { srtToVtt, languageName, shiftVtt, stripPromoCues, trackSpanMin,
         listSubtitles } from '../lib/subtitles';

describe('srtToVtt', () => {
  const srt = `1
00:03:41,958 --> 00:03:46,250
<i>Swinging off branches</i>

2
00:03:46,333 --> 00:03:53,000
Second line`;

  it('adds the WEBVTT header a <track> requires', () => {
    expect(srtToVtt(srt).startsWith('WEBVTT\n')).toBe(true);
  });

  it('converts comma millisecond separators to dots', () => {
    const out = srtToVtt(srt);
    expect(out).toContain('00:03:41.958 --> 00:03:46.250');
    expect(out).not.toContain(',958');
  });

  it('keeps the cue text intact, markup included', () => {
    expect(srtToVtt(srt)).toContain('<i>Swinging off branches</i>');
  });

  it('normalises CRLF, which SRT files commonly use', () => {
    const out = srtToVtt('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n');
    expect(out).not.toContain('\r');
    expect(out).toContain('00:00:01.000 --> 00:00:02.000');
  });

  it('strips a BOM rather than emitting an invalid header', () => {
    const out = srtToVtt('﻿1\n00:00:01,000 --> 00:00:02,000\nHi');
    expect(out.startsWith('WEBVTT')).toBe(true);
  });

  it('does not throw on empty input', () => {
    expect(srtToVtt('')).toBe('WEBVTT\n\n\n');
  });
});

describe('languageName', () => {
  it('names the household languages', () => {
    expect(languageName('tel')).toBe('Telugu');
    expect(languageName('kan')).toBe('Kannada');
    expect(languageName('mal')).toBe('Malayalam');
  });
  it('falls back to the raw code rather than showing nothing', () => {
    expect(languageName('xyz')).toBe('XYZ');
    expect(languageName(undefined)).toBe('');
  });
});


describe('shiftVtt', () => {
  const v = 'WEBVTT\n\n1\n00:00:10.500 --> 00:00:12.000\nHi\n';

  it('is a no-op at zero offset', () => {
    expect(shiftVtt(v, 0)).toBe(v);
  });

  it('delays cues by a positive offset', () => {
    expect(shiftVtt(v, 2000)).toContain('00:00:12.500 --> 00:00:14.000');
  });

  it('advances cues by a negative offset', () => {
    expect(shiftVtt(v, -500)).toContain('00:00:10.000 --> 00:00:11.500');
  });

  it('clamps at zero rather than emitting a negative timestamp', () => {
    const out = shiftVtt(v, -60000);
    expect(out).toContain('00:00:00.000');
    // The `-->` arrow legitimately contains hyphens; check the TIMESTAMPS.
    expect(out).not.toMatch(/-\d{2}:\d{2}/);
  });

  it('carries a shift across the minute and hour boundaries', () => {
    const nearHour = 'WEBVTT\n\n1\n00:59:59.500 --> 01:00:00.000\nX\n';
    expect(shiftVtt(nearHour, 1000)).toContain('01:00:00.500 --> 01:00:01.000');
  });

  it('leaves the cue text untouched', () => {
    expect(shiftVtt(v, 3000)).toContain('Hi');
  });
});


describe('stripPromoCues', () => {
  it('drops an OpenSubtitles advert cue', () => {
    // Measured on Baahubali's Malayalam track: the FIRST thing on screen.
    const v = ['WEBVTT', '',
      '1\n00:00:06.000 --> 00:00:12.074\nOpenSubtitles.org require your login in mx player',
      '2\n00:03:00.000 --> 00:03:02.000\nReal dialogue'].join('\n\n');
    const out = stripPromoCues(v);
    expect(out).not.toContain('OpenSubtitles.org');
    expect(out).toContain('Real dialogue');
  });

  it('keeps the WEBVTT header', () => {
    const v = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi';
    expect(stripPromoCues(v).startsWith('WEBVTT')).toBe(true);
  });

  it('does not drop dialogue that merely mentions a subtitle', () => {
    const v = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHe read the sign carefully';
    expect(stripPromoCues(v)).toContain('He read the sign carefully');
  });

  it('leaves a clean file untouched', () => {
    const v = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello\n\n2\n00:00:03.000 --> 00:00:04.000\nWorld';
    expect((stripPromoCues(v).match(/-->/g) || []).length).toBe(2);
  });
});


describe('trackSpanMin', () => {
  it('reads the runtime a file was cut for from its last cue', () => {
    const vtt = ['WEBVTT','','1\n00:00:10.000 --> 00:00:12.000\nA',
                 '2\n02:52:30.000 --> 02:52:34.000\nB'].join('\n\n');
    expect(trackSpanMin(vtt)).toBe(172);
  });
  it('is zero when there are no cues at all', () => {
    expect(trackSpanMin('WEBVTT\n\n')).toBe(0);
  });
});

describe('listSubtitles - guards against another film\'s captions', () => {
  it('refuses a missing or malformed imdb id rather than requesting one', async () => {
    // /subtitles/movie/undefined.json is exactly how a viewer ends up reading
    // the wrong film's dialogue.
    for (const bad of [undefined, null, '', 'undefined', 'tt12', '12345']) {
      expect(await listSubtitles({ imdbId: bad })).toEqual([]);
    }
  });
});
