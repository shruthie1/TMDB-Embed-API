import { describe, it, expect } from 'vitest';
import {
  loadingView, labelRows, advanceNotice, reasonFor, reasonFromText, retryPlan, langOf,
  Phase, RowState, Reason, CHECK_SERVER,
} from '../lib/player/loadingModel';

// Loading-ux spec section 8, web case 1. Same table as the APK's
// LoadingModelTest.kt: the strings must be copy-identical.
const src = (id, provider, { langs = ['Telugu'], q = '1080p', unsupported = false } = {}) =>
  ({ id, provider, masterUrl: `https://h/${id}`, quality: q, languages: langs, unsupported });

const list = [
  src('c1', 'CastleTV'), src('c2', 'CastleTV'), src('o1', 'OneTouchTV', { q: '720p' }),
  src('n1', 'NetMirror'), src('s1', 'showsst', { langs: ['Hindi'], q: '720p' }),
];
const labels = labelRows({}, list);
const A = (id, startedAt, endedAt = null, state = RowState.STARTING, reason = null) =>
  ({ id, startedAt, endedAt, state, reason });

function input(now, { listReady = false, attempts = [], framed = false, failed = false, checks = [], ...rest } = {}) {
  return {
    now, playAt: 0, title: 'Devara Part 1', preferred: 'Telugu',
    sources: listReady ? list : null, labels, firstListSize: listReady ? list.length : 0,
    attempts, checks, framed, failed, ...rest,
  };
}

describe('loadingModel timing rules', () => {
  it('no Try again and no chooser at 8s (regression: the old 8s timer)', () => {
    const v = loadingView(input(8000));
    expect(v.showTryAgain).toBe(false);
    expect(v.showChooser).toBe(false);
  });
  it('Try again only from 30s with no list', () => {
    expect(loadingView(input(29999)).showTryAgain).toBe(false);
    expect(loadingView(input(30000)).showTryAgain).toBe(true);
  });
  it('slow hint at 15s', () => {
    expect(loadingView(input(14999)).phase).toBe(Phase.FINDING);
    const v = loadingView(input(15000));
    expect(v.phase).toBe(Phase.FINDING_SLOW);
    expect(v.headline).toBe('Still finding sources…');
    expect(v.detail).toBe('First play of a title can take up to a minute.');
  });
  it('chooser at 30s with a list and no frame, never Try again', () => {
    const a = [A('c1', 1000)];
    expect(loadingView(input(29999, { listReady: true, attempts: a })).showChooser).toBe(false);
    const v = loadingView(input(30000, { listReady: true, attempts: a }));
    expect(v.showChooser).toBe(true);
    expect(v.showTryAgain).toBe(false);
  });
  it('never Try again while sources are left, even at 200s', () => {
    const a = [A('c1', 1000, 21000, RowState.FAILED, Reason.NO_PICTURE), A('c2', 21000)];
    expect(loadingView(input(200000, { listReady: true, attempts: a })).showTryAgain).toBe(false);
  });
  it('every row failed is the end card', () => {
    const v = loadingView(input(90000, { listReady: true, failed: true,
      attempts: list.map((s) => A(s.id, 0, 1, RowState.FAILED, Reason.NO_ANSWER)) }));
    expect(v.phase).toBe(Phase.FAILED);
    expect(v.showTryAgain).toBe(true);
    expect(v.headline).toBe("Couldn't start Devara Part 1");
    expect(v.detail).toBe('We tried 5 sources. None of them played.');
  });
});

describe('loadingModel copy per phase', () => {
  it('headlines and detail lines match the spec', () => {
    const finding = loadingView(input(4000));
    expect(finding.headline).toBe('Finding sources…');
    expect(finding.detail).toBe('Telugu first');
    expect(loadingView(input(7000)).detail).toBe('Telugu first · 7s');

    const found = loadingView(input(9000, { listReady: true }));
    expect(found.phase).toBe(Phase.FOUND);
    expect(found.headline).toBe('Found 5 sources');
    expect(found.detail).toBe('4 in Telugu');

    const starting = loadingView(input(9000, { listReady: true, attempts: [A('c2', 9000)] }));
    expect(starting.phase).toBe(Phase.STARTING);
    expect(starting.headline).toBe('Starting CastleTV 2');
    expect(starting.detail).toBe('Telugu · 1080p');

    const adv = loadingView(input(34000, { listReady: true, attempts: [
      A('c1', 9000, 29000, RowState.FAILED, Reason.NO_PICTURE), A('c2', 29000)] }));
    expect(adv.phase).toBe(Phase.ADVANCING);
    expect(adv.headline).toBe('CastleTV 1 is slow. Trying CastleTV 2.');
    expect(adv.detail).toBe('Telugu · 1080p · 2 of 5 tried');
    expect(adv.footer).toBe('Started 34s ago · 2 of 5 tried');

    const skip = loadingView(input(12000, { listReady: true, attempts: [
      A('c1', 9000, 10000, RowState.SKIPPED, Reason.UNSUPPORTED), A('o1', 10000)] }));
    expect(skip.phase).toBe(Phase.ADVANCING_SKIP);
    expect(skip.headline).toBe("CastleTV 1 won't play on this device. Trying OneTouchTV.");
  });
  it('rows that arrive after the list are "more found", not a bigger M', () => {
    const v = loadingView({ ...input(12000, { listReady: true, attempts: [
      A('c1', 9000, 10000, RowState.FAILED, Reason.NO_ANSWER), A('c2', 10000)] }), firstListSize: 3 });
    expect(v.detail).toBe('Telugu · 1080p · 2 of 3 tried · 2 more found');
  });
  it('k never goes down when the list indexes tried go 10, 9, 8', () => {
    let prev = 0;
    const tried = [];
    ['s1', 'n1', 'o1'].forEach((id, i) => {
      tried.forEach((a, j) => { tried[j] = { ...a, endedAt: a.endedAt ?? i * 1000, state: RowState.FAILED, reason: Reason.NO_ANSWER }; });
      tried.push(A(id, i * 1000));
      const k = Number(/(\d+) of \d+ tried/.exec(loadingView(input(40000, { listReady: true, attempts: tried })).footer)[1]);
      expect(k).toBeGreaterThan(prev);
      prev = k;
    });
  });
  it('shows Telugu by name, never the code', () => {
    expect(langOf(src('x', 'p', { langs: ['hi', 'te'] }), 'Telugu')).toBe('Telugu');
    expect(langOf(src('x', 'p', { langs: ['hi'] }), 'Telugu')).toBe('Hindi');
  });
});

describe('loadingModel rows', () => {
  it('search phase shows one honest Chitram server row', () => {
    const v = loadingView(input(7000, { checks: [{ id: CHECK_SERVER, label: 'Chitram server', startedAt: 0 }] }));
    expect(v.rows.map((r) => [r.title, r.status])).toEqual([['Chitram server', 'Checking… 7s']]);
    expect(v.rows.every((r) => !r.clickable)).toBe(true);
    expect(v.footer).toBe('Started 7s ago');
    const done = loadingView(input(7000, { checks: [
      { id: 'CastleTV', label: 'CastleTV', startedAt: 0, endedAt: 2100, found: 5 },
      { id: 'vidrock', label: 'vidrock', startedAt: 0, endedAt: 6000, found: 0 }] }));
    expect(done.rows.map((r) => r.status)).toEqual(['5 links · 2.1s', 'nothing found · 6.0s']);
  });
  it('rows in try order with state, language, quality and seconds', () => {
    const v = loadingView(input(34000, { listReady: true, attempts: [
      A('c1', 9000, 29000, RowState.FAILED, Reason.NO_PICTURE), A('c2', 28000)] }));
    expect(v.rows.map((r) => r.id)).toEqual(['c1', 'c2', 'o1', 'n1', 's1']);
    expect(v.rows[0].title).toBe('CastleTV 1 · Telugu · 1080p');
    expect(v.rows[0].status).toBe('Failed: no picture in 20s · 20s');
    expect(v.rows[1].status).toBe('Starting… 6s');
    expect(v.rows[2].status).toBe('Waiting');
    expect(v.rows[4].title).toBe('showsst · Hindi · 720p');
    expect(v.rows.map((r) => r.clickable)).toEqual([true, false, true, true, true]);
    expect(v.rows[0].description).toBe('CastleTV 1, Telugu, 1080p, failed: no picture in 20 seconds · 20 seconds');
  });
  it('playing row and an unsupported row', () => {
    const withBad = [...list, src('x1', 'vidrock', { q: '2160p', unsupported: true })];
    const v = loadingView({ ...input(12000, { listReady: true,
      attempts: [A('c1', 9000, 12100, RowState.PLAYING)] }), sources: withBad, labels: labelRows({}, withBad) });
    expect(v.rows.find((r) => r.id === 'c1').status).toBe('Playing · 3.1s to start');
    const bad = v.rows.find((r) => r.id === 'x1');
    expect(bad.status).toBe("Skipped: won't play on this device");
    expect(bad.clickable).toBe(false);
  });
});

describe('loadingModel labels and notices', () => {
  it('labels stay put when rows join or leave', () => {
    const first = labelRows({}, [src('a', 'showsst'), src('b', 'CastleTV')]);
    expect(first.a).toBe('showsst');
    const more = labelRows(first, [src('c', 'showsst'), src('a', 'showsst'), src('b', 'CastleTV')]);
    expect(more.a).toBe('showsst');
    expect(more.c).toBe('showsst 2');
    const less = labelRows(more, [src('c', 'showsst')]);
    expect(less.a).toBe('showsst');
    expect(less.a).not.toBe(less.c);
  });
  it('advanceNotice names two different servers (regression: "showsst 1 … playing showsst 1")', () => {
    expect(advanceNotice('CastleTV 1', 'CastleTV 2')).toBe('CastleTV 1 is slow. Trying CastleTV 2.');
    expect(advanceNotice('showsst', 'NetMirror', true)).toBe("showsst won't play on this device. Trying NetMirror.");
    const two = labelRows({}, [src('s1', 'showsst'), src('s2', 'showsst')]);
    expect(two.s1).not.toBe(two.s2);
  });
  it('reasons from errors', () => {
    expect(reasonFor(403, false)).toBe(Reason.EXPIRED);
    expect(reasonFor(410, false)).toBe(Reason.EXPIRED);
    expect(reasonFor(404, false)).toBe(Reason.NOT_FOUND);
    expect(reasonFor(502, false)).toBe(Reason.SERVER);
    expect(reasonFor(null, true)).toBe(Reason.UNSUPPORTED);
    expect(reasonFor(null, false)).toBe(Reason.STOPPED);
  });
  it('player failure words map onto the fixed reasons', () => {
    expect(reasonFromText('stale')).toBe(Reason.EXPIRED);
    expect(reasonFromText('codecs')).toBe(Reason.UNSUPPORTED);
    expect(reasonFromText('novideo')).toBe(Reason.UNSUPPORTED);
    expect(reasonFromText('startup timeout')).toBe('no picture in 15s');
    expect(reasonFromText('unreachable')).toBe(Reason.SERVER);
    expect(reasonFromText('startup stall')).toBe(Reason.STOPPED);
    expect(reasonFromText(undefined)).toBe(Reason.STOPPED);
  });
  it('Try again during the search does not refresh', () => {
    expect(retryPlan(false)).toEqual({ refresh: false, keepDevice: true });
    expect(retryPlan(true)).toEqual({ refresh: true, keepDevice: false });
  });
});
