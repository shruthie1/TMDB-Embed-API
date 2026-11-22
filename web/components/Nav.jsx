'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Icon from './Icon';
import PrefsButton from './PrefsPicker';

// Search first: on a TV rail it is the top item, as in Netflix and Hotstar.
// The phone tab bar puts Home first with CSS `order` (see nav.css).
const ITEMS = [
  { href: '/search', label: 'Search', icon: 'search' },
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/browse', label: 'Browse', icon: 'filters' },
  { href: '/list', label: 'My list', icon: 'bookmark' },
];

const isActive = (path, href) => (href === '/' ? path === '/' : path.startsWith(href));

/**
 * Navigation for TV and phone (nav.css). Desktop keeps TopNav instead.
 *   - TV: a left icon rail that opens to icon + label when focus enters it.
 *   - Phone: a bottom tab bar.
 * TopNav's language button owns the first-visit picker, so this one does not
 * open it a second time.
 */
export function AppNav() {
  const path = usePathname();
  return (
    <nav className="app-nav" aria-label="Primary" data-nav="" data-focus-group="">
      {ITEMS.map(i => (
        <Link key={i.href} href={i.href} data-focus=""
              className={`app-nav-item focusable${isActive(path, i.href) ? ' on' : ''}`}
              data-home={i.href === '/' ? '' : undefined}
              aria-label={i.label}
              aria-current={isActive(path, i.href) ? 'page' : undefined}>
          <Icon name={i.icon} size={22} />
          <span className="app-nav-label">{i.label}</span>
        </Link>
      ))}
      <PrefsButton className="app-nav-item" iconSize={22} />
    </nav>
  );
}

/** Desktop top bar links. Hidden on TV and phone (nav.css), where AppNav is. */
export function TopNav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Primary" data-focus-group="">
      {ITEMS.filter(i => i.href !== '/').map(i => (
        <Link key={i.href} href={i.href} data-focus=""
              className={`nav-link focusable ${isActive(path, i.href) ? 'on' : ''}`}
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
