import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next/navigation', () => ({ usePathname: () => '/browse' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => <a href={href} {...rest}>{children}</a>,
}));

import { AppNav, TopNav } from '../../components/Nav';

describe('AppNav (TV side rail / phone bottom tab bar)', () => {
  it('renders every destination once, with the current page marked', () => {
    const { container } = render(<AppNav />);
    const nav = container.querySelector('nav.app-nav[data-nav]');
    expect(nav).not.toBeNull();
    const labels = [...nav.querySelectorAll('.app-nav-item')].map(a => a.textContent.trim());
    expect(labels).toEqual(['Search', 'Home', 'Browse', 'My list', 'Languages']);
    const on = nav.querySelectorAll('.app-nav-item.on');
    expect(on).toHaveLength(1);
    expect(on[0].getAttribute('aria-current')).toBe('page');
    expect(on[0].textContent).toContain('Browse');
    // Every item is a D-pad stop.
    expect(nav.querySelectorAll('[data-focus]')).toHaveLength(5);
  });

  it('desktop top bar keeps its links (no Home)', () => {
    const { container } = render(<TopNav />);
    const labels = [...container.querySelectorAll('.nav-link')].map(a => a.textContent.trim());
    expect(labels).toEqual(['Search', 'Browse', 'My list', 'Languages']);
  });
});
