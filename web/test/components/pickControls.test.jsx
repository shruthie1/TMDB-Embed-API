import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

// Icon is NOT mocked here, deliberately. Every other player test stubs it to
// null, so a button whose icon name does not exist in the set renders EMPTY
// and the test still passes - the exact failure the seek-back/seek-fwd comment
// in Icon.jsx records. These assert the glyphs really draw.
let isCompact = false;
window.matchMedia = (q) => ({
  matches: isCompact, media: q,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
});

const { default: PlayerControls } = await import('../../components/PlayerControls');
const { default: Icon } = await import('../../components/Icon');

const LEVELS = [
  { index: 0, label: '1080p', bitrate: '5.0 Mbps', height: 1080 },
  { index: 1, label: '720p',  bitrate: '2.5 Mbps', height: 720 },
];
// The real CastleTV demux ladder: five muxed tracks, Telugu last.
const AUDIO = [
  { id: 0, name: 'Hindi',     lang: 'hin' },
  { id: 1, name: 'Kannada',   lang: 'kan' },
  { id: 2, name: 'Malayalam', lang: 'mal' },
  { id: 3, name: 'Tamil',     lang: 'tam' },
  { id: 4, name: 'Telugu',    lang: 'tel' },
];

function mount(props = {}) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
  return render(
    <PlayerControls videoRef={{ current: video }} title="RRR" visible
                    sources={[{ provider: 'CastleTV' }]} currentSource="CastleTV"
                    levels={LEVELS} currentLevel={-1} autoLevel="1080p"
                    subs={[]} currentSub={null}
                    audioTracks={AUDIO} currentAudio={4}
                    {...props} />,
  );
}

const qualityBtn = (c) => c.querySelector('[title="Video quality"]');
// The trigger badge repeats the active row's text, so queries must be scoped
// to the open popup or they match twice.
const rows = (c) => [...c.querySelectorAll('.pmenu-pick .pmenu-item')];
const row = (c, label) => rows(c).find(r => r.textContent.includes(label));
const audioBtn = (c) => c.querySelector('[aria-label^="Audio language"],[aria-label^="Audio:"]');

describe('quality and audio are their own controls', () => {
  it('both sit in the control row, outside the settings sheet', () => {
    const { container } = mount();
    expect(qualityBtn(container)).toBeTruthy();
    expect(audioBtn(container)).toBeTruthy();
    // Nothing is open yet: they must not require the gear.
    expect(container.querySelector('.pmenu')).toBeNull();
  });

  it('each button draws a real icon, not an empty box', () => {
    const { container } = mount();
    for (const btn of [qualityBtn(container), audioBtn(container)]) {
      const svg = btn.querySelector('svg.ico');
      expect(svg).toBeTruthy();
      // A glyph with no geometry is an invisible button.
      expect(svg.querySelectorAll('path,rect,circle,text').length).toBeGreaterThan(0);
    }
  });

  it('the icon set actually defines quality and audio', () => {
    for (const name of ['quality', 'audio']) {
      const { container } = render(<Icon name={name} />);
      expect(container.querySelector('svg'), `Icon "${name}" is missing`).toBeTruthy();
    }
  });

  it('each button shows its current value without being opened', () => {
    const { container } = mount();
    // Auto reports the rung hls.js settled on, not the word "Auto".
    expect(qualityBtn(container).textContent).toContain('1080p');
    expect(audioBtn(container).textContent).toContain('Telugu');
  });

  it('a pinned level shows that level instead of the auto rung', () => {
    const { container } = mount({ currentLevel: 1 });
    expect(qualityBtn(container).textContent).toContain('720p');
  });

  it('picking a quality reports the level index', () => {
    const onPickLevel = vi.fn();
    const { container } = mount({ onPickLevel });
    fireEvent.click(qualityBtn(container));
    fireEvent.click(row(container, '720p'));
    expect(onPickLevel).toHaveBeenCalledWith(1);
  });

  it('picking an audio track reports the track id', () => {
    const onPickAudio = vi.fn();
    const { container } = mount({ onPickAudio });
    fireEvent.click(audioBtn(container));
    fireEvent.click(row(container, 'Tamil'));
    expect(onPickAudio).toHaveBeenCalledWith(3);
  });

  it('all five demux languages are listed', () => {
    const { container } = mount();
    fireEvent.click(audioBtn(container));
    const names = rows(container).map(r => r.textContent);
    for (const t of AUDIO) expect(names.some(n => n.includes(t.name)), t.name).toBe(true);
    expect(rows(container).length).toBe(5);
  });

  it('opening one menu closes the other', () => {
    const { container } = mount();
    fireEvent.click(qualityBtn(container));
    expect(qualityBtn(container).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(audioBtn(container));
    expect(qualityBtn(container).getAttribute('aria-expanded')).toBe('false');
    expect(audioBtn(container).getAttribute('aria-expanded')).toBe('true');
    // Exactly one popup on screen - two overlapping in a 390px row is what the
    // single-sheet design existed to avoid.
    expect(container.querySelectorAll('.pmenu-pick').length).toBe(1);
  });

  // Anything promoted to its own button in the row must LEAVE the sheet, or
  // the same setting lives in two places and they drift. Source joined quality
  // and audio on 2026-09-22, when the provider list became the Servers button.
  it('the settings sheet no longer carries quality, audio or source', () => {
    // Subtitles are the sheet's remaining content, so the fixture must supply
    // some - otherwise the sheet is empty and the assertion proves nothing.
    const { container } = mount({ subs: [{ id: 'eng:0', name: 'English' }] });
    fireEvent.click(container.querySelector('[aria-label="Settings"]'));
    const labels = [...container.querySelectorAll('.pmenu-sheet .pmenu-label')]
      .map(n => n.textContent);
    expect(labels).not.toContain('Quality');
    expect(labels).not.toContain('Audio');
    expect(labels).not.toContain('Source');
    expect(labels).toContain('Subtitles');
  });

  it('an unknown ladder renders no quality button rather than a dead one', () => {
    const { container } = mount({ levels: [] });
    expect(qualityBtn(container)).toBeNull();
    expect(audioBtn(container)).toBeTruthy();
  });

  it('a single audio track informs but does not open a menu', () => {
    const { container } = mount({ audioTracks: [{ id: 0, name: 'Hindi' }], currentAudio: 0 });
    const btn = audioBtn(container);
    expect(btn.textContent).toContain('Hindi');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(btn);
    expect(container.querySelector('.pmenu-pick')).toBeNull();
  });

  // APK: the Audio button never vanishes. No known language reads "Default".
  it('no audio tracks at all still shows an informational Default audio button', () => {
    const { container } = mount({ audioTracks: [] });
    const btn = audioBtn(container);
    expect(btn.textContent).toContain('Default');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });
});

// The Salaar case (tmdb 770906, measured 2026-09-21): the provider ships ONE
// STREAM PER LANGUAGE instead of one master with muxed tracks. 13 streams are
// really 6 languages x 2 qualities. Before this, the Audio button showed a
// single dead entry and the other five languages were reachable only by
// opening Source and reading 13 near-identical rows.
const SALAAR = [
  { id: 'c-0', provider: 'CastleTV', languages: ['Telugu'], quality: '720p', masterUrl: 'u0' },
  { id: 'c-1', provider: 'CastleTV', languages: ['Telugu'], quality: '480p', masterUrl: 'u1' },
  { id: 'v-2', provider: 'VaPlayer', languages: [], quality: '1080p', masterUrl: 'u2' },
  { id: 'c-3', provider: 'CastleTV', languages: ['Hindi'], quality: '720p', masterUrl: 'u3' },
  { id: 'c-4', provider: 'CastleTV', languages: ['Tamil'], quality: '720p', masterUrl: 'u4' },
];

describe('audio languages that arrive as separate streams', () => {
  it('lists each language in the Audio menu, not just the one playing', () => {
    const { container } = mount({
      audioTracks: [], sources: SALAAR, currentSourceId: 'c-0', currentSource: 'CastleTV',
    });
    fireEvent.click(audioBtn(container));
    expect(rows(container).map(r => r.textContent.trim()))
      .toEqual(['Telugu', 'Hindi', 'Tamil']);
  });

  it('switching language hands back the SOURCE OBJECT, not an id', () => {
    // switchSource bails on `!src?.masterUrl`, so passing a bare id here is a
    // silent no-op: the menu closes and nothing changes. Unit-level shape
    // checks would not catch that, so assert the argument itself.
    const onPickSource = vi.fn();
    const { container } = mount({
      audioTracks: [], sources: SALAAR, currentSourceId: 'c-0',
      currentSource: 'CastleTV', onPickSource,
    });
    fireEvent.click(audioBtn(container));
    fireEvent.click(row(container, 'Hindi'));
    expect(onPickSource).toHaveBeenCalledTimes(1);
    const arg = onPickSource.mock.calls[0][0];
    expect(arg).toMatchObject({ id: 'c-3', masterUrl: 'u3' });
  });

  it('the trigger shows the language actually playing', () => {
    const { container } = mount({
      audioTracks: [], sources: SALAAR, currentSourceId: 'c-3', currentSource: 'CastleTV',
    });
    expect(audioBtn(container).textContent).toContain('Hindi');
  });

  it('a muxed master still switches in place rather than reloading a source', () => {
    // Keeping the playback position beats a reload, so the in-file path wins
    // whenever both are available.
    const onPickAudio = vi.fn();
    const onPickSource = vi.fn();
    const { container } = mount({
      audioTracks: AUDIO, currentAudio: 4, sources: SALAAR,
      currentSourceId: 'c-0', onPickAudio, onPickSource,
    });
    fireEvent.click(audioBtn(container));
    fireEvent.click(row(container, 'Kannada'));
    expect(onPickAudio).toHaveBeenCalledWith(1);
    expect(onPickSource).not.toHaveBeenCalled();
  });
});
