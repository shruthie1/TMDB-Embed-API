import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

vi.mock('../../components/Icon', () => ({ default: () => null }));
let isCompact = false;
window.matchMedia = (q) => ({
  matches: isCompact, media: q,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
});

const { default: PlayerControls } = await import('../../components/PlayerControls');

const SUBS = [
  { id: 'eng:0', name: 'English (Blu-ray)' },
  { id: 'eng:1', name: 'English (WEB-DL)' },
];
const LEVELS = [
  { index: 0, label: '1080p', bitrate: '5.0 Mbps', height: 1080 },
  { index: 1, label: '720p',  bitrate: '2.5 Mbps', height: 720 },
];
const SOURCES = [
  { id: 's0', provider: 'mapple', height: 2160, masterUrl: 'http://x/m.m3u8' },
  { id: 's1', provider: 'vidking', height: 1080, masterUrl: 'http://x/v.m3u8' },
];

// The provider list lives behind its own "Servers" button since 2026-09-22,
// not in the settings sheet. Same Row component, different trigger.
function openServers(props = {}) {
  const utils = openSheet(props);
  const btn = utils.container.querySelector('[aria-label^="Server"]');
  if (btn) fireEvent.click(btn);
  return utils;
}

// videoChoices() ignores a source with no masterUrl, so every fixture that
// expects to SEE a row must carry one.
const playable = (list) => list.map((s, i) => ({
  id: s.id ?? `f${i}`, masterUrl: `http://x/${i}.m3u8`, ...s,
}));

function openSheet(props = {}) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
  const utils = render(
    <PlayerControls videoRef={{ current: video }} title="RRR" visible
                    sources={SOURCES} currentSource="mapple"
                    levels={LEVELS} currentLevel={-1} autoLevel="1080p"
                    subs={SUBS} currentSub={null}
                    audioTracks={[]} currentAudio={null}
                    {...props} />,
  );
  // The settings control opens the sheet.
  const gear = utils.container.querySelector('[aria-label="Settings"]');
  if (gear) fireEvent.click(gear);
  return utils;
}

describe('settings sheet rows are clickable across their whole width', () => {
  // The Servers menu states the provider and its ceiling, and nothing else.
  //
  // It used to append the language list, so a row read "up to 720p · Hindi,
  // Kannada, Malayalam +2". At the menu's real width that wrapped onto three
  // lines and ran straight through the provider name beside it. The Audio
  // control already names the language that is playing, so the list was
  // repeating what the viewer can read one button over.
  it('states the provider and its ceiling', () => {
    const { container } = openServers({
      sources: playable([
        { provider: 'mapple', best: '2160p', codecs: { video: 'HEVC' },
          audioTracks: [{ lang: 'en' }, { lang: 'te' }] },
        { provider: 'vidking', quality: '1080p' },
      ]),
      currentSource: 'mapple',
    });
    const rows = [...container.querySelectorAll('.pmenu-pick .pmenu-item')]
      .map((r) => r.textContent);
    expect(rows.some((t) => t.includes('vidking') && t.includes('1 stream'))).toBe(true);
    // No codec tail and no audio-track count: both belong to the settings
    // sheet, which has the width for them.
    expect(container.textContent).not.toContain('HEVC');
    expect(container.textContent).not.toContain('2 audio');
  });

  // The real 1511417 case: CastleTV returned four streams and every row
  // rendered as a bare "CastleTV". Languages used to do the disambiguating;
  // now a numeric suffix does, which costs one short word instead of a
  // wrapped paragraph.
  it('numbers same-provider rows that share a ceiling', () => {
    const { container } = openServers({
      sources: playable([
        { provider: 'CastleTV', languages: ['Telugu'], quality: '720p' },
        { provider: 'CastleTV', languages: ['Kannada'], quality: '720p' },
        { provider: 'CastleTV', languages: ['Telugu'], quality: '480p' },
        { provider: 'VaPlayer', languages: [], quality: 'Auto' },
      ]),
      currentSource: 'CastleTV',
    });
    fireEvent.click([...container.querySelectorAll('.pmenu-pick .pmenu-item')].find(r => r.querySelector('.pmenu-text').textContent === 'CastleTV'));
    const rows = [...container.querySelectorAll('.pmenu-pick .pmenu-item')]
      .map((r) => r.textContent);
    // Every CastleTV row is numbered, once, across the WHOLE list.
    expect(rows.some((t) => t.includes('CastleTV 1') && t.includes('720p'))).toBe(true);
    expect(rows.some((t) => t.includes('CastleTV 2') && t.includes('720p'))).toBe(true);
    // The 480p row gets the next ordinal rather than restarting at 1.
    // Numbering per ceiling made the counter reset, so a provider with rows at
    // two ceilings showed "CastleTV 1" twice and the ordinal stopped telling
    // the rows apart - which is the one job it has. Measured on movie/912649:
    // CastleTV 1-4 at 720p followed by CastleTV 1-4 again at 480p.
    const low = rows.find((t) => t.includes('480p'));
    expect(low).toContain('CastleTV 3');
    // No ordinal collides with another.
    const ordinals = rows.map((t) => (t.match(/CastleTV (\d)/) || [])[1]).filter(Boolean);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect(container.textContent).toContain('Telugu');
    expect(container.textContent).toContain('Kannada');
  });

  it('ticks exactly one server row even when two sources share an id', () => {
    // useResolve merges late-arriving providers by PROVIDER NAME while ids are
    // minted by array index in backend.toSource(), so a duplicate id is
    // reachable from real data. Two ticks in one radio group is invalid ARIA
    // and was visible in the UI as two check marks at once.
    const dupes = [
      { id: 'dup', provider: 'CastleTV', languages: [], quality: '720p',
        masterUrl: 'http://x/a.m3u8' },
      { id: 'dup', provider: 'CastleTV', languages: [], quality: '720p',
        masterUrl: 'http://x/b.m3u8' },
    ];
    const { container } = openServers({ sources: dupes, currentSourceId: 'dup' });
    const checked = [...container.querySelectorAll('.pmenu-pick [role="menuitemradio"]')]
      .filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
  });

  it('ticks the PICTURE row while a cross-provider pair is playing', () => {
    // pickPair sets the id to `pair-<video>-<audio>`. That used to tick no row
    // at all, which left the viewer unable to tell which server was on (and
    // the button fell back to the first row's name). The picture is the video
    // half, so that row is the honest answer.
    const { container } = openServers({
      sources: playable([
        { provider: 'mapple', languages: [], quality: '720p' },
        { provider: 'CastleTV', languages: ['Telugu'], quality: '720p' },
      ]),
      currentSourceId: 'pair-f0-f1',
    });
    const checked = [...container.querySelectorAll('.pmenu-pick [role="menuitemradio"]')]
      .filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('mapple');
  });

  it('never leaves a dangling separator on a row with no extra detail', () => {
    const { container } = openServers({
      sources: playable([
        { provider: 'VaPlayer', languages: [], quality: 'Auto' },
        { provider: 'vidking', quality: '1080p' },
      ]),
      currentSource: 'VaPlayer',
    });
    const rows = [...container.querySelectorAll('.pmenu-pick .pmenu-item')]
      .map((r) => r.textContent);
    const va = rows.find((t) => t.includes('VaPlayer'));
    expect(va).toBeTruthy();
    expect(va).toContain('1 stream');
    expect(va).not.toMatch(/·\s*$/);
    expect(va).not.toContain('· ·');
  });

  it('a row survives a re-render instead of being remounted', () => {
    // THE BUG: Row was declared inside SettingsSheet, so every render created a
    // new component TYPE and React remounted every row rather than updating it.
    // A click needs mousedown and mouseup on the SAME element, and the sheet
    // re-renders constantly while open (3s idle timer, subLoading and
    // sourcesPending arriving from the network) - so a remount landed
    // mid-press and the click was swallowed.
    const { container, rerender } = openSheet();
    const before = container.querySelector('.pmenu-item');
    expect(before).toBeTruthy();

    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
    // Exactly the prop churn that happens live while the sheet is open.
    rerender(
      <PlayerControls videoRef={{ current: video }} title="RRR" visible
                      sources={SOURCES} currentSource="mapple" sourcesPending
                      levels={LEVELS} currentLevel={-1} autoLevel="1080p"
                      subs={SUBS} currentSub={null} subLoading
                      audioTracks={[]} currentAudio={null} />,
    );
    const after = container.querySelector('.pmenu-item');
    // Same DOM node, not a replacement: this is what makes a press land.
    expect(after).toBe(before);
  });

  it('clicking the LABEL of a row fires it, not just the right-hand side', () => {
    // The reported symptom: the right of a row worked, the left did nothing.
    const onPickSub = vi.fn();
    const { container } = openSheet({ onPickSub });
    const rows = [...container.querySelectorAll('.pmenu-item')];
    const target = rows.find(r => /Blu-ray/.test(r.textContent));
    expect(target).toBeTruthy();

    // Click the label span - the part that used to be dead.
    const label = target.querySelector('.pmenu-text');
    expect(label).toBeTruthy();
    fireEvent.click(label);
    expect(onPickSub).toHaveBeenCalledWith('eng:0');
  });

  it('every row in every group is one button, so there is no dead zone', () => {
    // Servers, Quality and Subtitles all render through the same Row. Only ONE
    // popup is open at a time, so each trigger is checked in turn rather than
    // counting every row on screen at once.
    const { container } = openSheet();
    const triggers = ['Settings', 'Server', 'Video quality'];
    let seen = 0;
    for (const tag of triggers) {
      const btn = container.querySelector(`[aria-label^="${tag}"]`);
      if (!btn) continue;
      fireEvent.click(btn);
      const rows = [...container.querySelectorAll('.pmenu-item')];
      // A control with a single option renders a static badge and no menu;
      // that is correct, so it simply contributes nothing to the count.
      for (const r of rows) {
        expect(r.tagName).toBe('BUTTON');
        // Text lives inside the button, so a press anywhere activates it.
        expect(r.textContent.trim().length).toBeGreaterThan(0);
      }
      seen += rows.length;
      fireEvent.click(btn);
    }
    expect(seen).toBeGreaterThan(3);
  });
});

describe('picture fit in the settings sheet', () => {
  const rows = (c) => [...c.querySelectorAll('.pmenu-sheet [role="menuitemradio"]')]
    .map(b => b.textContent.trim());

  it('lists Fit whole, Fill screen and Stretch on a phone, current one ticked', () => {
    isCompact = true;
    const onSetFit = vi.fn();
    const { container, unmount } = openSheet({ fit: 'cover', onSetFit });
    const r = rows(container);
    expect(r).toEqual(expect.arrayContaining(['Fit whole', 'Fill screen', 'Stretch']));
    const on = [...container.querySelectorAll('.pmenu-sheet [aria-checked="true"]')].map(b => b.textContent.trim());
    expect(on).toContain('Fill screen');
    const stretch = [...container.querySelectorAll('.pmenu-sheet [role="menuitemradio"]')]
      .find(b => b.textContent.trim() === 'Stretch');
    fireEvent.click(stretch);
    expect(onSetFit).toHaveBeenCalledWith('fill');
    unmount(); isCompact = false;
  });

  it('stays out of the desktop sheet, where the row has the fit icon', () => {
    const { container, unmount } = openSheet({ fit: 'contain', onSetFit: () => {} });
    expect(rows(container)).not.toContain('Stretch');
    expect(container.querySelector('[aria-label^="Picture fit"]')).not.toBeNull();
    unmount();
  });
});


describe('partial NetMirror source coverage', () => {
  it('lets even one partial source open its menu and states that more sources are pending', () => {
    const { container } = openServers({ sources: [{ id: 'nm-1', provider: 'NetMirror', masterUrl: 'https://x/nm.m3u8', quality: '720p', languages: ['Telugu'], incomplete: true }], currentSourceId: 'nm-1' });
    expect(container.textContent).toContain('More streams pending');
    expect(container.querySelector('[aria-label^="Server:"]').getAttribute('aria-disabled')).not.toBe('true');
    expect(container.querySelectorAll('.pmenu-pick [aria-checked="true"]')).toHaveLength(1);
  });
});

it('offers explicit continuation without picking a source and disables it while checking', () => {
  const onCheckSources=vi.fn(),onPickSource=vi.fn();
  const props={sources:[{id:'nm-1',provider:'NetMirror',masterUrl:'https://x/nm.mp4',quality:'720p',incomplete:true}],currentSourceId:'nm-1',onCheckSources,onPickSource};
  let view=openServers(props);fireEvent.click(view.getByRole('menuitem',{name:'Check for more streams'}));
  expect(onCheckSources).toHaveBeenCalledTimes(1);expect(onPickSource).not.toHaveBeenCalled();
  view.unmount();view=openServers({...props,checkingSources:true});expect(view.getByRole('menuitem',{name:'Checking sources…'}).disabled).toBe(true);
});
