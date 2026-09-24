import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import { EmbedFallback } from '../../components/player/overlays';

// Unmount between tests: without it, every render stacks in the same document
// and a query matches the button from an earlier test as well.
afterEach(cleanup);

describe('EmbedFallback', () => {
  const embeds = [
    { provider: 'vidcore', url: 'https://vidcore.org/embed/movie/1' },
    { provider: 'mapple', url: 'https://mapple.uk/watch/movie/1' },
  ];

  it('renders nothing when no provider is embeddable', () => {
    const { container } = render(<EmbedFallback embeds={[]} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('offers one button per embeddable provider', () => {
    const { container } = render(<EmbedFallback embeds={embeds} onClose={() => {}} />);
    const q = within(container);
    expect(q.getByRole('button', { name: /Try vidcore/ })).toBeTruthy();
    expect(q.getByRole('button', { name: /Try mapple/ })).toBeTruthy();
  });

  it('opens the frame only after a deliberate choice', () => {
    const { container } = render(<EmbedFallback embeds={embeds} onClose={() => {}} />);
    const q = within(container);
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(q.getByRole('button', { name: /Try vidcore/ }));
    expect(container.querySelector('iframe').src).toContain('vidcore.org');
  });

  it('KEEPS the sandbox on the frame', () => {
    // Providers that refuse to run sandboxed are simply not embeddable. Their
    // pages inject popunders (popads, propeller, adsterra - the hosts our
    // extractor blocks), which without the sandbox could navigate the tab.
    const { container } = render(<EmbedFallback embeds={embeds} onClose={() => {}} />);
    const q = within(container);
    fireEvent.click(q.getByRole('button', { name: /Try vidcore/ }));
    const sandbox = container.querySelector('iframe').getAttribute('sandbox');
    expect(sandbox).toBeTruthy();
    expect(sandbox).not.toContain('allow-popups');
    expect(sandbox).not.toContain('allow-top-navigation');
  });

  it('sends no referrer to the provider', () => {
    const { container } = render(<EmbedFallback embeds={embeds} onClose={() => {}} />);
    const q = within(container);
    fireEvent.click(q.getByRole('button', { name: /Try mapple/ }));
    expect(container.querySelector('iframe').getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('says plainly that watch position is not saved', () => {
    const { container } = render(<EmbedFallback embeds={embeds} onClose={() => {}} />);
    const q = within(container);
    fireEvent.click(q.getByRole('button', { name: /Try vidcore/ }));
    expect(q.getByText(/not saved/i)).toBeTruthy();
  });

  it('can go back to the choice without closing the player', () => {
    const { container } = render(<EmbedFallback embeds={embeds} onClose={() => {}} />);
    const q = within(container);
    fireEvent.click(q.getByRole('button', { name: /Try vidcore/ }));
    fireEvent.click(q.getByRole('button', { name: /^Back$/ }));
    expect(container.querySelector('iframe')).toBeNull();
    expect(q.getByRole('button', { name: /Try vidcore/ })).toBeTruthy();
  });
});
