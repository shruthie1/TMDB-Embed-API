# Design tokens

All raw colour, radius, shadow, spacing, motion and z-index values live in
`app/tokens.css`. It loads first in `app/layout.jsx`. Every other stylesheet
and component reads the variables.

## Rules

- Do not write hex, `rgba()`, raw radius or shadow values outside `tokens.css`.
- Spacing uses `--space-*`. Half steps (`--space-1-5` = 6px) exist so older layouts stay pixel-exact.
- For a colour with alpha, use the channel token: `rgb(var(--rgb-bg) / .6)`.
- Buttons and chips use no gradient and no glow. `--color-accent` (cyan) is only for small things: progress bars, the active hero dot, the desktop nav underline, the spinner and the focus ring.
- TV changes tokens only, in the `[data-tv="true"]` block at the end of `tokens.css`.
- `--header-h` and `--backdrop-reach` are measured at runtime by `components/HeaderScroll.jsx`.

## Groups

| Group | Tokens |
|---|---|
| Colour | `--color-bg`, `--color-surface-1/2/3` (glass), `--color-border(-strong)`, `--color-text-primary/secondary/muted/dim`, `--color-accent`, `--color-success/warn/danger`, `--color-focus`, `--color-scrim`, `--header-scrim`, `--header-scrim-h` |
| Buttons, chips | `--btn-primary-bg/-bg-hover/-fg` (solid white, near-black text), `--btn-secondary-bg/-bg-hover/-fg` (white 10%), `--chip-on-bg/-fg` (white 90%, dark text), `--btn-h` 40/44/52, `--btn-font`, `--control-h` 32/34/44 (chips, sort, Filters) |
| Channels | `--rgb-bg`, `--rgb-surface`, `--rgb-text`, `--rgb-white`, `--rgb-black`, `--rgb-accent-from/to`, `--rgb-success/warn/danger` |
| Radius | `--radius-xs` 4, `-sm` 8, `-md` 12, `-lg` 16, `-xl` 24, `-card` 14, `-pill`, `-round` |
| Spacing | `--space-0-5` 2px to `--space-24` 96px, 4px base |
| Type | `--font-sans` (Inter), `--font-display` (Space Grotesk), `--font-telugu`, `--text-xs` to `--text-3xl`, `--lh-*`, `--weight-*` |
| Shadow, glow, ring | `--shadow-sm/md/lg`, `--glow-focus` (plain 2px ring, 3px on TV), `--ring-neutral`, `--ring-offset` |
| Blur | `--blur-sm`, `--blur-glass`, `--blur-scrim` |
| Motion | `--duration-fast/base/slow`, `--ease-standard`, `--ease-out`, `--focus-scale`. All durations are 0 under `prefers-reduced-motion`. |
| Z-index | `--z-raised`, `--z-focus`, `--z-header`, `--z-bottom-nav`, `--z-scrim`, `--z-panel`, `--z-player`, `--z-modal`, `--z-toast` |
| Hero | `--hero-height`, `--hero-title-size`, `--detail-band`, `--detail-band-overlap`, `--header-height` 48/56/64, `--header-h`, `--tabbar-h` 56 |

## Breakpoints

CSS variables cannot be used inside `@media`, so these values are fixed:

| Name | Rule |
|---|---|
| Mobile | `max-width:559px` (detail layout), `< 720px` (tab bar) |
| Desktop | `min-width:720px` |
| TV | `[data-tv="true"]` on `<html>`, set by `lib/dpad.js` or `?tv=1` |

## States

- Primary button: solid white, near-black text. Secondary: translucent white, white text.
- Selected chip or language tile: near-white fill, dark text. Unselected: transparent, 1px neutral border, muted text.
- Bottom tab bar: inactive muted, active white icon and label. No pill or underline.
- Player controls: transparent icon buttons, soft fill on hover, `--ring-neutral` on `:focus-visible`.
- Focus: `--glow-focus` cyan ring (cards also `scale(var(--focus-scale))`). Focus never uses the fill, so focus and selected look different.
- Disabled: 40% opacity, no glow.

## Page backdrop

Pages with hero art add the class `page-backdrop` to the art element. The art starts at y=0 behind a transparent header with a `--header-scrim` (black 70% to 0 over `--header-scrim-h`), and its bottom fades into `--color-bg`. Past 24px of scroll the header turns solid `--color-bg`. Pages without a backdrop have a flat `--color-bg` page and a solid header from the start, so there is no seam.
