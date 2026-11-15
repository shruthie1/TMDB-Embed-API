'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Icon from './Icon';
import PrefsButton from './PrefsPicker';

const ITEMS = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/search', label: 'Search', icon: 'search' },
  { href: '/browse', label: 'Browse', icon: 'filters' },
  { href: '/list', label: 'My list', icon: 'bookmark' },
];

const isActive = (path, href) => (href === '/' ? path === '/' : path.startsWith(href));

/**
 * Top bar navigation.
 *
 * On a phone the bottom tabs carry Home/Browse/My list, so the top bar keeps
 * only Search - reachable without leaving the thumb zone twice, and the one
 * action people expect top-right.
 */
export function TopNav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Primary" data-focus-group="">
      {ITEMS.slice(1).map(i => (
        <Link key={i.href} href={i.href} data-focus=""
              className={`nav-link focusable ${isActive(path, i.href) ? 'on' : ''}`
                         + (i.href === '/search' ? ' nav-search' : '')}
              aria-label={i.label}
              aria-current={isActive(path, i.href) ? 'page' : undefined}>
          <Icon name={i.icon} size={15} />
          <span>{i.label}</span>
        </Link>
      ))}
      <PrefsButton />
    </nav>
  );
}

/** Mobile: bottom tabs, within thumb reach. Hidden on TV and desktop. */
export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="bottom-nav" aria-label="Primary" data-focus-group="">
      {ITEMS.map(i => (
        <Link key={i.href} href={i.href} data-focus=""
              className={`tab focusable ${isActive(path, i.href) ? 'on' : ''}`}
              aria-current={isActive(path, i.href) ? 'page' : undefined}>
          <Icon name={i.icon} size={19} />
          <span>{i.label}</span>
        </Link>
      ))}
    </nav>
  );
}
