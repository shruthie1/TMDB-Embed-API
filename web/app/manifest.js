/**
 * Web app manifest — served by Next at /manifest.webmanifest.
 *
 * This replaces the hand-written public/manifest.webmanifest, which shipped a
 * lone SVG icon. Android will not offer an install for an SVG-only manifest:
 * Chrome requires at least one PNG of 192px or more, and a separate `maskable`
 * entry to avoid the OS letterboxing the icon inside a white rounded square.
 *
 * A route file wins over a same-named file in /public, so the old static file
 * is deleted rather than left to shadow this one ambiguously.
 */
export default function manifest() {
  return {
    name: 'Chitram',
    short_name: 'Chitram',
    description: 'A private cinema.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // Standalone Android apps must permit landscape before screen.orientation
    // can lock the player during fullscreen. The player still stays portrait
    // while browsing and requests landscape only for playback.
    orientation: 'any',
    background_color: '#06070C', // = --color-bg (tokens.css)
    theme_color: '#06070C',
    categories: ['entertainment', 'video'],
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      // Kept separate from the `any` entries on purpose: a single icon declaring
      // "any maskable" gets cropped when used as a plain icon, so the glyph in
      // this one is drawn smaller to survive Android's circular mask.
      {
        src: '/icons/maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
