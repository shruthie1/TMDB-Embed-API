import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import QualityMenu from '../../components/player/QualityMenu';
import AudioMenu from '../../components/player/AudioMenu';
import VideoMenu from '../../components/player/VideoMenu';

afterEach(cleanup);

function Fixture({ onPick = () => {}, onKey = () => {} }) {
  const [menu, setMenu] = useState(null);
  return <div onKeyDown={onKey}>
    <QualityMenu levels={[{ index: 0, label: '720p', bitrate: '2 Mbps' }]}
      currentLevel={-1} open={menu === 'quality'} onToggle={() => setMenu(menu ? null : 'quality')}
      onPickLevel={onPick} />
    <AudioMenu audioTracks={[{ id: 'te', name: 'Telugu' }, { id: 'ta', name: 'Tamil' }]}
      currentAudio="te" open={menu === 'audio'} onToggle={() => setMenu(menu ? null : 'audio')}
      onPickAudio={onPick} />
    <VideoMenu choices={[{ id: 'one', provider: 'First' }, { id: 'two', provider: 'Second' }]}
      currentId="one" open={menu === 'server'} onToggle={() => setMenu(menu ? null : 'server')}
      onPick={onPick} />
  </div>;
}

describe('shared player menus', () => {
  it.each([
    ['Video quality:', 'Quality', 'Close quality'],
    ['Audio language:', 'Audio', 'Close audio'],
    ['Server:', 'Server', 'Close server'],
  ])('closes %s and leaves the opener usable for the next open', (label, name, close) => {
    const { container, getByRole, queryByRole } = render(<Fixture />);
    const trigger = container.querySelector(`[aria-label^="${label}"]`);
    fireEvent.click(trigger);
    expect(getByRole('menu', { name })).toBeTruthy();
    fireEvent.click(getByRole('button', { name: close }));
    expect(queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(getByRole('menu', { name })).toBeTruthy();
  });

  it('Escape closes only this menu and restores its trigger before another menu opens', () => {
    const parentKey = vi.fn();
    const { container, getByRole, queryByRole } = render(<Fixture onKey={parentKey} />);
    const quality = container.querySelector('[aria-label^="Video quality:"]');
    fireEvent.click(quality);
    fireEvent.keyDown(getByRole('menu', { name: 'Quality' }), { key: 'Escape' });
    expect(queryByRole('menu')).toBeNull();
    expect(parentKey).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(quality);
    fireEvent.click(container.querySelector('[aria-label^="Audio language:"]'));
    expect(getByRole('menu', { name: 'Audio' })).toBeTruthy();
  });

  it('preserves selection and invokes the original action from the full row', () => {
    const pick = vi.fn();
    const { container, getByRole } = render(<Fixture onPick={pick} />);
    fireEvent.click(container.querySelector('[aria-label^="Video quality:"]'));
    const auto = getByRole('menuitemradio', { name: 'Auto adapts to your connection' });
    expect(auto.getAttribute('aria-checked')).toBe('true');
    const row = getByRole('menuitemradio', { name: '720p 2 Mbps' });
    expect(row.querySelector('.pmenu-marker')).toBeTruthy();
    expect(row.querySelector('.pmenu-copy .pmenu-meta').textContent).toBe('2 Mbps');
    fireEvent.click(row);
    expect(pick).toHaveBeenCalledWith(0);
  });
});
