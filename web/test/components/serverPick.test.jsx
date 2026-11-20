import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { useState } from 'react';

window.matchMedia = (q) => ({
  matches: false, media: q,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
});

const { default: PlayerControls } = await import('../../components/PlayerControls');
const { useSwitchGuard } = await import('../../lib/player/useSwitchGuard');

// GET /api/streams/movie/811941 (Devara), 2026-11-16: five CastleTV rows and
// OneTouchTV, ids as lib/backend.js toSource() mints them.
const src = (i, provider, quality, languages, extra = {}) => ({
  id: `${provider}-${i}`, provider, quality, languages,
  masterUrl: `https://x/${provider}-${i}.m3u8`, levels: [], progressive: false, ...extra,
});
const SOURCES = [
  src(0, 'CastleTV', '720p', ['Kannada', 'Malayalam', 'Tamil', 'Telugu'], { selectableAudio: true }),
  src(1, 'CastleTV', '720p', ['Telugu', 'Tamil', 'Malayalam', 'Kannada']),
  src(2, 'CastleTV', '480p', ['Telugu', 'Tamil', 'Malayalam', 'Kannada']),
  src(3, 'CastleTV', '720p', ['Hindi']),
  src(4, 'CastleTV', '480p', ['Hindi']),
  src(5, 'OneTouchTV', 'Auto', []),
];

const serverBtn = (c) => c.querySelector('[aria-label^="Server:"]');
const badge = (c) => serverBtn(c).querySelector('.pctl-pick-badge').textContent;
const rows = (c) => [...c.querySelectorAll('.pmenu-pick .pmenu-item')];
const row = (c, label) => rows(c).find((r) => r.querySelector('.pmenu-text').textContent === label);
const checked = (c) => rows(c).filter((r) => r.getAttribute('aria-checked') === 'true');
const openServers = (c) => fireEvent.click(serverBtn(c));

function mount(props) {
  const video = document.createElement('video');
  return render(
    <PlayerControls videoRef={{ current: video }} title="Devara" visible
                    sources={SOURCES} levels={[]} subs={[]} {...props} />,
  );
}

describe('Servers menu marks what is playing', () => {
  it('a pairing ticks its PICTURE row and the button names it', () => {
    // Picking OneTouchTV with Telugu standing pairs it with CastleTV's Telugu.
    const { container } = mount({
      currentSourceId: 'pair-OneTouchTV-5-CastleTV-0', currentSource: 'OneTouchTV+CastleTV',
    });
    expect(badge(container)).toBe('OneTouchTV');
    openServers(container);
    const on = checked(container);
    expect(on).toHaveLength(1);
    expect(on[0]).toBe(row(container, 'OneTouchTV'));
    expect(on[0].getAttribute('aria-current')).toBe('true');
    expect(on[0].querySelector('svg.pmenu-check')).toBeTruthy();
  });

  it('the button names the exact CastleTV entry, numbered like the rows', () => {
    const { container } = mount({ currentSourceId: 'CastleTV-1', currentSource: 'CastleTV' });
    expect(badge(container)).toBe('CastleTV 2');
    openServers(container);
    expect(checked(container)).toEqual([row(container, 'CastleTV')]);
    fireEvent.click(row(container, 'CastleTV'));
    expect(checked(container)).toEqual([row(container, 'CastleTV 2')]);
  });
});

/**
 * The menus wired to a stand-in for Player.jsx: the pick goes through the
 * same guard, and `fail` plays the part of onFatal (e.g. a 403 on the master).
 */
function Harness({ onSwitch, notices, guardOut }) {
  const [cur, setCur] = useState({ id: 'CastleTV-0', provider: 'CastleTV' });
  const guard = useSwitchGuard({
    revert: (prev) => setCur({ id: prev.id, provider: prev.provider }),
    onRevert: (m) => notices.push(m),
  });
  guardOut.current = guard;
  const video = document.createElement('video');
  return (
    <PlayerControls videoRef={{ current: video }} title="Devara" visible
                    sources={SOURCES} levels={[]} subs={[]}
                    currentSourceId={cur.id} currentSource={cur.provider}
                    onPickSource={(s) => {
                      const now = SOURCES.find((x) => x.id === cur.id);
                      guard.begin({ ...now, label: 'CastleTV 1', at: 42 }, s.provider);
                      onSwitch(s);
                      setCur({ id: s.id, provider: s.provider });
                    }} />
  );
}

describe('picking a server', () => {
  it('switches, moves the tick and the label, and closes the menu', () => {
    const onSwitch = vi.fn();
    const { container } = render(<Harness onSwitch={onSwitch} notices={[]} guardOut={{}} />);
    openServers(container);
    expect(checked(container)).toEqual([row(container, 'CastleTV')]);
    fireEvent.click(row(container, 'OneTouchTV'));
    fireEvent.click(row(container, 'OneTouchTV'));
    expect(onSwitch).toHaveBeenCalledWith(SOURCES[5]);
    expect(container.querySelector('.pmenu-pick')).toBeNull();
    expect(badge(container)).toBe('OneTouchTV');
    openServers(container);
    expect(checked(container)).toEqual([row(container, 'OneTouchTV')]);
  });

  it('a failed switch puts the tick back on what is actually playing', () => {
    const notices = [];
    const guardOut = {};
    const { container } = render(
      <Harness onSwitch={() => {}} notices={notices} guardOut={guardOut} />,
    );
    openServers(container);
    fireEvent.click(row(container, 'OneTouchTV'));
    fireEvent.click(row(container, 'OneTouchTV'));
    let reverted;
    act(() => { reverted = guardOut.current.fail(); });
    expect(reverted).toBe(true);
    expect(notices).toEqual(['OneTouchTV did not load. Back on CastleTV 1.']);
    expect(badge(container)).toBe('CastleTV 1');
    openServers(container);
    expect(checked(container)).toEqual([row(container, 'CastleTV')]);
  });
});

describe('useSwitchGuard', () => {
  it('does nothing once the new stream landed', () => {
    const revert = vi.fn();
    const { result } = renderHook(() => useSwitchGuard({ revert }));
    result.current.begin({ id: 'a', masterUrl: 'https://x/a.m3u8' }, 'B');
    result.current.landed();
    expect(result.current.fail()).toBe(false);
    expect(revert).not.toHaveBeenCalled();
  });

  it('reverts to the snapshot, position included', () => {
    const revert = vi.fn();
    const { result } = renderHook(() => useSwitchGuard({ revert }));
    const prev = { id: 'a', masterUrl: 'https://x/a.m3u8', at: 812.5 };
    result.current.begin(prev, 'B');
    expect(result.current.fail()).toBe(true);
    expect(revert).toHaveBeenCalledWith(prev);
    // One revert per pick: a second fatal is the generic path's business.
    expect(result.current.fail()).toBe(false);
  });
});
