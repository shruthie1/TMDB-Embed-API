import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useState } from 'react';

window.matchMedia = (q) => ({
  matches: false, media: q,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
});

const { default: PlayerControls } = await import('../../components/PlayerControls');
const { default: EmbedStage } = await import('../../components/player/EmbedStage');
const { videoChoices } = await import('../../lib/player/trackChoices');
const {
  VA_EMBED_ID, vaEmbedUrl, vaEmbedChoice, shouldAutoEmbed,
} = await import('../../lib/player/vaEmbed');

const SOURCES = [
  { id: 'CastleTV-0', provider: 'CastleTV', quality: '720p', masterUrl: 'https://x/0.m3u8', levels: [] },
  { id: 'OneTouchTV-5', provider: 'OneTouchTV', quality: 'Auto', masterUrl: 'https://x/5.m3u8', levels: [] },
];
const DEVARA = { imdbId: 'tt11821912', mediaType: 'movie' };

const serverBtn = (c) => c.querySelector('[aria-label^="Server:"]');
const rowTexts = (c) => [...c.querySelectorAll('.pmenu-pick .pmenu-item .pmenu-text')]
  .map((n) => n.textContent);

describe('vaEmbedUrl', () => {
  it('builds the public movie and episode pages', () => {
    expect(vaEmbedUrl(DEVARA)).toBe('https://vaplayer.ru/embed/movie/tt11821912');
    expect(vaEmbedUrl({ imdbId: 'tt0944947', mediaType: 'tv', season: 1, episode: 2 }))
      .toBe('https://vaplayer.ru/embed/tv/tt0944947/1/2');
  });
  it('offers nothing without a real imdb id or episode', () => {
    expect(vaEmbedUrl({ imdbId: null, mediaType: 'movie' })).toBeNull();
    expect(vaEmbedUrl({ imdbId: 'tt0944947', mediaType: 'tv', season: 0, episode: 0 })).toBeNull();
  });
});

describe('the embed row in the Servers menu', () => {
  const mount = (embed) => render(
    <PlayerControls videoRef={{ current: document.createElement('video') }} title="Devara"
                    visible sources={SOURCES} levels={[]} subs={[]}
                    currentSourceId="CastleTV-0" currentSource="CastleTV"
                    embed={embed} />,
  );

  it('is listed LAST when the title has an imdb id', () => {
    const { container } = mount(vaEmbedChoice(DEVARA));
    fireEvent.click(serverBtn(container));
    expect(rowTexts(container)).toEqual(['CastleTV', 'OneTouchTV', 'VaPlayer (embed)']);
  });

  it('is absent when it has none', () => {
    const { container } = mount(vaEmbedChoice({ mediaType: 'movie' }));
    fireEvent.click(serverBtn(container));
    expect(rowTexts(container)).not.toContain('VaPlayer (embed)');
  });
});

// The same switch Player.jsx uses: PlayerControls until the embed is picked,
// then EmbedStage with the frame, Close and the Servers menu.
function Harness({ onBack }) {
  const [on, setOn] = useState(false);
  const embed = vaEmbedChoice(DEVARA);
  if (on) {
    return (
      <EmbedStage url={embed.url} choices={[...videoChoices(SOURCES), embed]}
                  onPick={(c) => { setOn(false); onBack(c); }} onClose={() => {}} />
    );
  }
  return (
    <PlayerControls videoRef={{ current: document.createElement('video') }} title="Devara"
                    visible sources={SOURCES} levels={[]} subs={[]}
                    currentSourceId="CastleTV-0" currentSource="CastleTV"
                    embed={embed} onPickEmbed={() => setOn(true)} />
  );
}

describe('selecting the embed', () => {
  it('renders the frame with the expected src and attributes, and marks it active', () => {
    const { container } = render(<Harness onBack={() => {}} />);
    fireEvent.click(serverBtn(container));
    const va = [...container.querySelectorAll('.pmenu-pick .pmenu-item')]
      .find((r) => r.textContent.includes('VaPlayer (embed)'));
    fireEvent.click(va);

    const frame = container.querySelector('iframe');
    expect(frame.getAttribute('src')).toBe('https://vaplayer.ru/embed/movie/tt11821912');
    expect(frame.getAttribute('allow')).toBe('autoplay; fullscreen; encrypted-media; picture-in-picture');
    expect(frame.hasAttribute('allowfullscreen')).toBe(true);
    expect(frame.getAttribute('referrerpolicy')).toBe('origin');
    // VaPlayer's page detects a sandbox and refuses to play.
    expect(frame.hasAttribute('sandbox')).toBe(false);

    // Our quality / audio / subtitle controls are gone; Close and Servers stay.
    expect(container.querySelector('[title="Video quality"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Audio"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Close"][data-focus]')).toBeTruthy();
    expect(serverBtn(container).hasAttribute('data-focus')).toBe(true);
    expect(serverBtn(container).querySelector('.pctl-pick-badge').textContent)
      .toBe('VaPlayer (embed)');

    fireEvent.click(serverBtn(container));
    const on = [...container.querySelectorAll('.pmenu-pick .pmenu-item')]
      .filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(on.map((r) => r.querySelector('.pmenu-text').textContent)).toEqual(['VaPlayer (embed)']);
  });

  it('a Servers row inside the embed goes back to our player', () => {
    const onBack = vi.fn();
    const { container } = render(<Harness onBack={onBack} />);
    fireEvent.click(serverBtn(container));
    fireEvent.click([...container.querySelectorAll('.pmenu-pick .pmenu-item')].at(-1));
    fireEvent.click(serverBtn(container));
    fireEvent.click([...container.querySelectorAll('.pmenu-pick .pmenu-item')]
      .find((r) => r.textContent.includes('OneTouchTV')));
    fireEvent.click([...container.querySelectorAll('.pmenu-pick .pmenu-item')].find(r => r.textContent.includes('OneTouchTV')));
    expect(onBack).toHaveBeenCalledWith(expect.objectContaining({ id: 'OneTouchTV-5' }));
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('the TV frame takes no focus, so the remote stays on Close and Servers', () => {
    const { container } = render(
      <EmbedStage url="https://vaplayer.ru/embed/movie/tt11821912" tv
                  choices={[vaEmbedChoice(DEVARA)]} onClose={() => {}} />,
    );
    expect(container.querySelector('iframe').getAttribute('tabindex')).toBe('-1');
  });
});

describe('automatic use', () => {
  const embed = vaEmbedChoice(DEVARA);
  const error = { message: 'No playable source found.' };

  it('only when the resolve returned zero sources', () => {
    expect(shouldAutoEmbed({ embed, error, sources: [] })).toBe(true);
  });

  it('never while sources are in hand, even after one CastleTV row failed', () => {
    // Devara: five CastleTV rows. One failure used to mark them all dead by
    // provider name, and the embed replaced a title with four rows left.
    const castle = [0, 1, 2, 3, 4].map((i) => ({
      id: `CastleTV-${i}`, provider: 'CastleTV', masterUrl: `https://x/${i}.m3u8`,
    }));
    expect(shouldAutoEmbed({ embed, error, sources: castle, dead: new Set(['CastleTV']) }))
      .toBe(false);
    expect(shouldAutoEmbed({ embed, error, sources: SOURCES, dead: new Set(['CastleTV']) }))
      .toBe(false);
    expect(shouldAutoEmbed({ embed, error: null, sources: [] })).toBe(false);
    expect(shouldAutoEmbed({ embed: null, error, sources: [] })).toBe(false);
  });

  it('the row id is stable', () => {
    expect(embed.id).toBe(VA_EMBED_ID);
  });
});
