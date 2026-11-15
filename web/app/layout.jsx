import './globals.css';
import './tv-compact.css';
import Dpad from '../components/Dpad';
import Diagnostics from '../components/Diagnostics';
import { TopNav, BottomNav } from '../components/Nav';
import Shortcuts from '../components/Shortcuts';
import InstallPrompt from '../components/InstallPrompt';

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
  themeColor: '#08080A',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/* Chrome's standard PWA capability marker. Keep the Apple-specific
            metadata below for iOS, where this standard name is ignored. */}
        <meta name="mobile-web-app-capable" content="yes" />
        {/* Stream CDNs 403 a FOREIGN referer but allow none at all (measured:
            referer=localhost -> 403, no referer -> 200). Browsers forbid JS from
            setting Referer, so we suppress it document-wide instead. */}
        <meta name="referrer" content="no-referrer" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,200;9..144,400;9..144,600&family=Inter+Tight:wght@300;400;500&family=Noto+Serif+Telugu:wght@300&display=swap"
        />
      </head>
      <body>
        <header className="topbar">
          <a href="/" className="brand focusable" data-focus="" aria-label="Chitram home">
            <span>Chi<em>tram</em></span>
            <span className="brand-te" aria-hidden="true">చిత్రం</span>
          </a>
          <TopNav />
        </header>
        <main>{children}</main>
        <BottomNav />
        <Shortcuts />
        <InstallPrompt />
        <Dpad />
        <Diagnostics />
      </body>
    </html>
  );
}
