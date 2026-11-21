import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { popoverPlacement, popoverInset } from '../../components/player/popover';
import VideoMenu, { streamCount, netmirrorNote } from '../../components/player/VideoMenu';

vi.mock('../../components/Icon', () => ({ default: () => null }));
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const { default: PlayerControls } = await import('../../components/PlayerControls');
afterEach(cleanup);

// APK 1.2.15 MenuPanel geometry: bottom 8px above the button, centred on it,
// clamped to min(16, height/16) from every edge.
describe('popover placement (APK MenuPanel)', () => {
  const vp = { width: 844, height: 390 };
  const m = popoverInset(390);
  it('sits 8px above the button, centred on it', () => {
    const p = popoverPlacement({ left: 400, top: 340, width: 40 }, { width: 240, height: 200 }, vp);
    expect(p.left).toBe(420 - 120);
    expect(p.top + 200).toBe(332);
  });
  it('clamps at the right and left edges', () => {
    expect(popoverPlacement({ left: 800, top: 340, width: 40 }, { width: 240, height: 100 }, vp).left).toBe(844 - 240 - m);
    expect(popoverPlacement({ left: 0, top: 340, width: 40 }, { width: 240, height: 100 }, vp).left).toBe(m);
  });
  it('caps the height between the top margin and the button', () => {
    const p = popoverPlacement({ left: 400, top: 340, width: 40 }, { width: 240, height: 900 }, vp);
    expect(p.maxHeight).toBe(332 - m);
    expect(p.top).toBe(m);
  });
  it('caps at 480 on a tall screen', () => {
    expect(popoverPlacement({ left: 400, top: 1000, width: 40 }, { width: 240, height: 900 }, { width: 1920, height: 1080 }).maxHeight).toBe(480);
  });
});

describe('APK sheet wording', () => {
  it('pluralises streams', () => {
    expect(streamCount(1)).toBe('1 stream');
    expect(streamCount(3)).toBe('3 streams');
  });
  it('says what a NetMirror check found', () => {
    expect(netmirrorNote(0, 0)).toBe('No NetMirror streams for this title');
    expect(netmirrorNote(1, 4)).toBe('3 added');
    expect(netmirrorNote(2, 2)).toBe('No new streams');
  });
  it('shows the check result under the Check row once checking ends', () => {
    const nm = (i) => ({ id: `nm${i}`, label: 'NetMirror', quality: '720p', source: { id: `nm${i}`, provider: 'NetMirror', languages: ['Telugu'] } });
    const props = { open: true, currentId: 'nm0', onCheckSources: () => {}, provider: 'NetMirror', onProvider: () => {} };
    const view = render(<VideoMenu {...props} choices={[nm(0)]} checkingSources />);
    view.rerender(<VideoMenu {...props} choices={[nm(0), nm(1)]} checkingSources={false} />);
    expect(view.getByRole('menuitem', { name: 'Check for more streams' }).textContent).toContain('1 added');
  });
  it('re-tapping the playing row only closes the sheet (A2)', () => {
    const pick = vi.fn(), toggle = vi.fn();
    const choices = [{ id: 'a', label: 'CastleTV', quality: '720p', source: { id: 'a', provider: 'CastleTV', languages: ['Telugu'] } },
      { id: 'b', label: 'CastleTV', quality: '480p', source: { id: 'b', provider: 'CastleTV', languages: ['Telugu'] } }];
    const view = render(<VideoMenu open choices={choices} currentId="a" onPick={pick} onToggle={toggle} />);
    fireEvent.click(view.getByRole('menuitemradio', { name: /CastleTV/ }));
    fireEvent.click(view.getAllByRole('menuitemradio')[0]);
    expect(pick).not.toHaveBeenCalled();
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe('player Back on a drilled Server sheet (APK back())', () => {
  function setup(menuOpen) {
    const video = document.createElement('video');
    const onMenuChange = vi.fn();
    const sources = ['a', 'b'].map((id) => ({ id, provider: 'CastleTV', masterUrl: `http://x/${id}.m3u8`, languages: ['Telugu'] }));
    const el = (open) => <PlayerControls videoRef={{ current: video }} title="RRR" visible sources={sources} currentSource="CastleTV"
      levels={[]} currentLevel={-1} subs={[]} currentSub={null} audioTracks={[]} currentAudio={null}
      onMenuChange={onMenuChange} menuOpen={open} />;
    const view = render(el(menuOpen));
    return { view, onMenuChange, rerender: (open) => view.rerender(el(open)) };
  }
  it('goes up to the server list first, then closes', () => {
    const { view, onMenuChange, rerender } = setup(true);
    fireEvent.click(view.container.querySelector('[aria-label^="Server"]'));
    fireEvent.click(view.getByRole('menuitemradio', { name: /CastleTV/ }));
    expect(view.getByRole('menu', { name: 'CastleTV' })).toBeTruthy();
    rerender(false);                       // Player.jsx Back clears its flag
    expect(view.getByRole('menu', { name: 'Server' })).toBeTruthy();
    expect(onMenuChange).toHaveBeenLastCalledWith(true);
    rerender(true);
    // Rows still respond after going up: drill again, then back out.
    fireEvent.click(view.getByRole('menuitemradio', { name: /CastleTV/ }));
    expect(view.getAllByRole('menuitemradio')).toHaveLength(2);
    fireEvent.click(view.getByRole('button', { name: 'Back to servers' }));
    expect(view.getByRole('menu', { name: 'Server' })).toBeTruthy();
    rerender(false);
    expect(view.queryByRole('menu')).toBeNull();
  });
});
