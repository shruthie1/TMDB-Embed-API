import { describe, it, expect } from 'vitest';
import { heightOf, videoChoices, audioChoices, pairingFor } from '../lib/player/trackChoices';

// Shapes from GET /api/streams/movie/1355228 (Gandhari) and 770906 (Salaar),
// captured 2026-09-22 with hybrid auto-injection off.
const CASTLE_MULTI = {
  id: 'CastleTV-0', provider: 'CastleTV', quality: '720p', masterUrl: 'http://x/cd/master.m3u8',
  levels: [{ height: 720 }], languages: ['English', 'Hindi', 'Tamil', 'Telugu'],
  selectableAudio: true, progressive: false,
};
const SHOWSST = {
  id: 'showsst-3', provider: 'showsst', quality: '1080p', masterUrl: 'http://x/ss/master.m3u8',
  levels: [{ height: 1080 }], languages: [], selectableAudio: false, progressive: false,
};
const CASTLE_TELUGU_ONLY = {
  id: 'CastleTV-9', provider: 'CastleTV', quality: '720p', masterUrl: 'http://x/ct/master.m3u8',
  levels: [{ height: 720 }], languages: ['Telugu'], selectableAudio: false, progressive: false,
};

describe('heightOf', () => {
  it('prefers the measured ladder over the quality label', () => {
    expect(heightOf({ levels: [{ height: 804 }], quality: '1080p' })).toBe(804);
  });
  it('falls back to the label, then to 0 so unknowns sort last', () => {
    expect(heightOf({ levels: [], quality: '720p' })).toBe(720);
    expect(heightOf({})).toBe(0);
  });
});

describe('videoChoices', () => {
  it('lists every source, best picture first', () => {
    const v = videoChoices([CASTLE_MULTI, SHOWSST]);
    expect(v.map((c) => c.label)).toEqual(['showsst', 'CastleTV']);
  });
  it('a progressive file loses to HLS of the same height', () => {
    const prog = { ...SHOWSST, id: 'p', provider: 'VaPlayer', progressive: true };
    const v = videoChoices([prog, SHOWSST]);
    expect(v[0].label).toBe('showsst');
  });
  it('drops a source with no url rather than offering a dead row', () => {
    expect(videoChoices([{ id: 'x', provider: 'Broken' }])).toHaveLength(0);
  });
});

describe('audioChoices', () => {
  // A track already inside the chosen picture needs no pairing at all, so it
  // must win over the same language sitting in another source.
  it('prefers a track inside the chosen source over the same language elsewhere', () => {
    const a = audioChoices([CASTLE_MULTI], SHOWSST.id, [{ id: 0, name: 'Telugu' }]);
    const telugu = a.filter((c) => c.language.toLowerCase() === 'telugu');
    expect(telugu).toHaveLength(1);
    expect(telugu[0].kind).toBe('in-file');
  });

  it('offers every language of a multi-track source as pairable', () => {
    const a = audioChoices([CASTLE_MULTI], SHOWSST.id, []);
    expect(a.map((c) => c.language)).toEqual(['English', 'Hindi', 'Tamil', 'Telugu']);
    expect(a.every((c) => c.kind === 'pairable')).toBe(true);
  });

  // Salaar: Castle ships each language as its own muxed file. There is no
  // separate track to lift, so the whole source has to be swapped in.
  it('a single-language source offers only its own language, as whole-source', () => {
    const a = audioChoices([CASTLE_TELUGU_ONLY], SHOWSST.id, []);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ language: 'Telugu', kind: 'whole-source' });
  });

  it('never lists the same language twice', () => {
    const a = audioChoices([CASTLE_MULTI, CASTLE_TELUGU_ONLY], SHOWSST.id, []);
    const langs = a.map((c) => c.language.toLowerCase());
    expect(new Set(langs).size).toBe(langs.length);
  });

  it('does not offer the chosen video source as a separate audio source', () => {
    const a = audioChoices([CASTLE_MULTI], CASTLE_MULTI.id, []);
    expect(a).toHaveLength(0);
  });
});

describe('pairingFor', () => {
  it('an in-file track plays as one stream', () => {
    const p = pairingFor({ id: 'v' }, { kind: 'in-file', trackId: 2, language: 'Telugu' });
    expect(p.mode).toBe('in-file');
    expect(p.trackId).toBe(2);
  });

  it('a pairable track keeps the chosen picture', () => {
    const v = videoChoices([SHOWSST])[0];
    const a = audioChoices([CASTLE_MULTI], SHOWSST.id, [])
      .find((c) => c.language === 'Telugu');
    const p = pairingFor(v, a);
    expect(p.mode).toBe('pair');
    expect(p.video.label).toBe('showsst');
  });

  // The honest case: choosing this language REPLACES the picture, and the UI
  // has to say so rather than silently dropping the viewer to 720p.
  it('a whole-source language substitutes the picture and says why', () => {
    const v = videoChoices([SHOWSST])[0];
    const a = audioChoices([CASTLE_TELUGU_ONLY], SHOWSST.id, [])[0];
    const p = pairingFor(v, a);
    expect(p.mode).toBe('substitute');
    expect(p.note).toMatch(/only available at 720p/);
  });

  it('no audio choice leaves the video playing as-is', () => {
    expect(pairingFor({ id: 'v' }, null).mode).toBe('in-file');
  });
});

describe('videoIdOf and videoLabels', async () => {
  const { videoIdOf, videoLabels } = await import('../lib/player/trackChoices');
  const S = [{ id: 'CastleTV-1' }, { id: 'CastleTV-10' }, { id: 'OneTouchTV-5' }];
  it('a plain row is itself', () => {
    expect(videoIdOf('CastleTV-1', S)).toBe('CastleTV-1');
  });
  it('a pair, and a nudged pair, map to the video half, longest id first', () => {
    expect(videoIdOf('pair-OneTouchTV-5-CastleTV-1', S)).toBe('OneTouchTV-5');
    expect(videoIdOf('pair-CastleTV-10-CastleTV-1-n0.5', S)).toBe('CastleTV-10');
  });
  it('an unknown id is no row', () => {
    expect(videoIdOf('gone-3', S)).toBeNull();
    expect(videoIdOf(null, S)).toBeNull();
  });
  it('numbers a repeated provider once across the list', () => {
    expect(videoLabels([{ label: 'A' }, { label: 'B' }, { label: 'A' }]))
      .toEqual(['A 1', 'B', 'A 2']);
  });
});

describe('audioChoices uses real renditions over post.php languages', () => {
  it('offers only the languages the master really carries', () => {
    const nm = {
      id: 'NetMirror-1', provider: 'NetMirror', quality: '720p', masterUrl: 'http://x/nm/master.m3u8',
      levels: [{ height: 720 }], languages: ['Hindi', 'Telugu', 'Tamil'],
      audio: [{ language: 'Telugu' }, { language: 'Hindi' }],
      selectableAudio: true, progressive: false,
    };
    const labels = audioChoices([SHOWSST, nm], SHOWSST.id).map((c) => c.id);
    expect(labels).toContain('src:NetMirror-1:Telugu');
    expect(labels).toContain('src:NetMirror-1:Hindi');
    expect(labels).not.toContain('src:NetMirror-1:Tamil');
  });
  it('falls back to languages when no audio list is sent', () => {
    const labels = audioChoices([SHOWSST, CASTLE_MULTI], SHOWSST.id).map((c) => c.id);
    expect(labels).toContain('src:CastleTV-0:Telugu');
    expect(labels).toContain('src:CastleTV-0:Tamil');
  });
});


it('catalog display languages never become selectable audio choices', () => {
  const nm = { id: 'nm', provider: 'NetMirror', masterUrl: 'https://x/nm.m3u8', languages: ['Hindi'], catalogLanguages: ['Hindi', 'Telugu'], audio: [{ language: 'Hindi' }], selectableAudio: true };
  expect(audioChoices([SHOWSST, nm], SHOWSST.id).map(c=>c.language)).toEqual(['Hindi']);
});
