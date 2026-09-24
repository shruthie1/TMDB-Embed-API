'use client';

/**
 * Icon set. One 24-grid, 1.5px strokes so glyphs hold at 17px on a phone and
 * 24px across a room. Filled only where a shape must read instantly (play, and
 * the "saved" state). Inline SVG rather than a font, so icons inherit colour
 * and focus styles.
 */
const P = {
  play:       { solid: true,  d: 'M6 4v16l14-8z' },
  pause:      { d: 'M8 5v14M16 5v14' },
  plus:       { d: 'M12 5v14M5 12h14' },
  check:      { d: 'M4 12.5 9.5 18 20 6.5' },
  search:     { d: 'M16 16l4.5 4.5', circle: [11, 11, 6.5] },
  home:       { d: 'M3 11.5 12 4l9 7.5M5.5 10V20h13V10' },
  filters:    { d: 'M4 6h16M7 12h10M10 18h4' },
  bookmark:   { d: 'M6 5h12v15l-6-4.2L6 20z' },
  back:       { d: 'M15 5l-7 7 7 7' },
  close:      { d: 'M6 6l12 12M18 6L6 18' },
  fullscreen: { d: 'M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4' },
  // Picture fit. Distinguishable at 17px: contain shows the frame inset with
  // bars, cover shows it overflowing the screen, fill shows it stretched.
  'fit-contain': { d: 'M3 8h18M3 16h18', rect: [3, 8, 18, 8, 1] },
  'fit-cover':   { d: 'M7 3v18M17 3v18', rect: [3, 6, 18, 12, 1] },
  'fit-fill':    { d: 'M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3', rect: [3, 6, 18, 12, 1] },
  volume:     { d: 'M4 9v6h4l5 4V5L8 9zM17 9.5a4 4 0 0 1 0 5' },
  mute:       { d: 'M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6' },
  offline:    { d: 'M3 3l18 18M7.5 7.5A8.5 8.5 0 0 0 3 12M16.5 7.5A8.5 8.5 0 0 1 21 12M10 10a3 3 0 0 0-1.5 2M14 10a3 3 0 0 1 1.5 2M12 17h.01' },
  subtitles:  { d: 'M7 14h4M14 14h3', rect: [3, 6, 18, 12, 1.5] },
  next:       { solid: true, d: 'M5 4v16l10-8zM17 4h2v16h-2z' },
  star:       { d: 'M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2-5.6-3.3-5.6 3.3 1.4-6.2L3 9.5l6.4-.6z' },
  clock:      { d: 'M12 8v4.5l3 1.8', circle: [12, 12, 8] },
  seasons:    { d: 'M4 6h16v12H4zM4 10h16M9 6v4' },
  chevron:    { d: 'M9 5l7 7-7 7' },
  restart:    { d: 'M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4' },
  sort:       { d: 'M6 5v14M3 16l3 3 3-3M18 19V5M15 8l3-3 3 3' },
  // Skip back/forward 10s. PlayerControls asked for these by name and the set
  // had neither, so Icon returned null and both buttons rendered EMPTY — the
  // "invisible buttons" in the player. The arc is drawn open at the top with
  // the arrowhead on the leading edge, so direction reads at a glance.
  // Settings: three sliders, which reads as "options" more clearly than a gear
  // at 17px and matches the 1.5px-stroke set.
  settings:   { d: 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3'
                   + 'M13 5v4M7 10v4M13 15v4' },
  // Quality and audio now sit in the control row as their own buttons, so they
  // need their own glyphs. A missing name renders an EMPTY button (see the
  // seek-back note above), so these must exist before PlayerControls asks.
  // Quality: ascending bars, the universal "resolution ladder" read, and it
  // stays legible at 17px where a stacked "HD" wordmark does not.
  quality:    { d: 'M5 19v-5M12 19V9M19 19V5' },
  // Audio: a speech/waveform pair. Deliberately NOT the speaker glyph, which
  // `volume` already owns - two buttons sharing a speaker in one row would
  // read as duplicate volume controls rather than language selection.
  audio:      { d: 'M12 4v16M8 8v8M16 8v8M4 11v2M20 11v2' },
  'seek-back': { d: 'M3.6 10.5A9 9 0 1 1 3 15M3 5.5V11h5.5', text: '10' },
  'seek-fwd':  { d: 'M20.4 10.5A9 9 0 1 0 21 15M21 5.5V11h-5.5', text: '10' },
};

export default function Icon({ name, size = 18, className = '', ...rest }) {
  const g = P[name];
  if (!g) return null;
  const stroke = g.solid ? 'none' : 'currentColor';
  const fill = g.solid ? 'currentColor' : 'none';
  return (
    <svg
      className={`ico ${className}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={fill}
      stroke={stroke}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {g.rect && <rect x={g.rect[0]} y={g.rect[1]} width={g.rect[2]} height={g.rect[3]} rx={g.rect[4]} />}
      {g.circle && <circle cx={g.circle[0]} cy={g.circle[1]} r={g.circle[2]} />}
      {g.d && <path d={g.d} />}
      {/* A numeral inside the glyph (the 10 in skip-10s). Filled, since a
          1.5px stroke is unreadable at this size. */}
      {g.text && (
        <text x="12" y="17.6" textAnchor="middle" fontSize="9" fontWeight="700"
              fill="currentColor" stroke="none"
              style={{ fontFamily: 'system-ui, sans-serif' }}>{g.text}</text>
      )}
    </svg>
  );
}
