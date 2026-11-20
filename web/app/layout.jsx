import { Inter, Space_Grotesk, Noto_Serif_Telugu } from 'next/font/google';
import './tokens.css';
import './globals.css';
import './tv-compact.css';
import './prefs-modal.css';
import './nav.css';
import './cards.css';
import Dpad from '../components/Dpad';
import HeaderScroll from '../components/HeaderScroll';
import Diagnostics from '../components/Diagnostics';
import { TopNav, AppNav } from '../components/Nav';
import Shortcuts from '../components/Shortcuts';
import InstallPrompt from '../components/InstallPrompt';

// Self-hosted by next/font; the CSS variables feed --font-* in tokens.css.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const grotesk = Space_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-grotesk', display: 'swap' });
const telugu = Noto_Serif_Telugu({ subsets: ['telugu'], weight: ['300'], variable: '--font-te', display: 'swap' });

export const metadata = {
  title: { default: 'Chitram', template: '%s · Chitram' },
  description: 'A private cinema.',
  manifest: '/manifest.webmanifest',
  icons: {
    // SVG first for crisp desktop tabs; the PNGs are what Android's installer
    // and the home-screen shortcut actually consume (Chrome will not install
    // from an SVG-only icon set).
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon-180.png', sizes: '180x180' }],
  },
  appleWebApp: { capable: true, title: 'Chitram', statusBarStyle: 'black-translucent' },
};

export const viewport = {
  themeColor: '#06070C', // = --color-bg; metadata cannot read CSS variables
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable} ${telugu.variable}`}>
      <head>
        {/* Chrome's standard PWA capability marker. Keep the Apple-specific
            metadata below for iOS, where this standard name is ignored. */}
        <meta name="mobile-web-app-capable" content="yes" />
        {/* Stream CDNs 403 a FOREIGN referer but allow none at all (measured:
            referer=localhost -> 403, no referer -> 200). Browsers forbid JS from
            setting Referer, so we suppress it document-wide instead. */}
        <meta name="referrer" content="no-referrer" />
      </head>
      <body>
        {/* Desktop: this is the sticky top bar. TV and phone: only the
            wordmark shows and it scrolls away with the page; their navigation
            is AppNav, a left rail (TV) or a bottom tab bar (phone). nav.css. */}
        <header className="topbar">
          <a href="/" className="brand focusable" data-focus="" aria-label="Chitram home">
            <span>Chi<em>tram</em></span>
            <span className="brand-te" aria-hidden="true">చిత్రం</span>
          </a>
          <TopNav />
        </header>
        <HeaderScroll />
        <AppNav />
        <main>{children}</main>
        <Shortcuts />
        <InstallPrompt />
        <Dpad />
        <Diagnostics />
      </body>
    </html>
  );
}
