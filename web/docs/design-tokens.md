# Design tokens

All raw colour, radius, shadow, spacing, motion and z-index values live in
`app/tokens.css`. It loads first in `app/layout.jsx`. Every other stylesheet
and component reads the variables.

## Rules

- Do not write hex, `rgba()`, raw radius or shadow values outside `tokens.css`.
- Spacing uses `--space-*`. Half steps (`--space-1-5` = 6px) exist so older layouts stay pixel-exact.
- For a colour with alpha, use the channel token: `rgb(var(--rgb-bg) / .6)`.
- Buttons and chips use no gradient and no glow. `--color-accent` (cyan) is only for the focus ring, watch-progress bars and the desktop nav underline. Indicators (carousel bars, spinner, countdown) are neutral: `--indicator` / `--indicator-active`.
- Colour with alpha uses a named level, never an inline `rgb(var(--rgb-*) / a)`: `--color-fill-0..3` (light washes), `--color-overlay-1..5` (dark scrims), `--color-surface-1..3`, `--glass-bg`.
- Borders use `--color-border`, or `--color-border-hover` for hover and edges that must show. Status lines (`--color-danger-line` etc.) are the only other border colours.
- Radius: `--radius-sm` 6, `--radius-md` 10, `--radius-lg` 16, `--radius-pill`. Nothing else.
- Focus: one ring for everything, `outline:var(--focus-ring)` at `var(--focus-offset)`, on `:focus-visible` only (and D-pad focus on TV). It lives in the "Focus: one ring" block at the end of `globals.css`; component rules never set outline or box-shadow on `:focus`. Rails pad their scroll box by `--rail-focus-pad` so the ring and the focus scale are never clipped.
- TV changes tokens only, in the `[data-tv="true"]` block at the end of `tokens.css`.
- `--header-h` and `--backdrop-reach` are measured at runtime by `components/HeaderScroll.jsx`.

## Groups

| Group | Tokens |
|---|---|
| Colour | `--color-bg`, `--color-surface-1/2/3` (glass), `--color-border(-strong)`, `--color-text-primary/secondary/muted/dim`, `--color-accent`, `--color-success/warn/danger`, `--color-focus`, `--color-scrim`, `--header-scrim`, `--header-scrim-h` |
| Buttons, chips | `--btn-primary-bg/-bg-hover/-fg` (solid white, near-black text), `--btn-secondary-bg/-bg-hover/-fg` (white 10%), `--chip-on-bg/-fg` (white 90%, dark text), `--btn-h` 40/44/52, `--btn-font`, `--control-h` 32/34/44 (chips, sort, Filters) |
| Channels | `--rgb-bg`, `--rgb-surface`, `--rgb-text`, `--rgb-white`, `--rgb-black`, `--rgb-accent-from/to`, `--rgb-success/warn/danger` |
| Radius | `--radius-sm` 6, `-md` 10, `-lg` 16, `-pill` |
| Glass | `--glass-bg` (bg 72%, TV 85%), `--glass-blur` (none on TV), `--glass-hairline`: scrolled header, tab bar, player card |
| Indicators | `--text-faint`, `--indicator`, `--indicator-active`, `--hero-rotate` |
| Spacing | `--space-0-5` 2px to `--space-24` 96px, 4px base |
| Type | `--font-sans` (Inter), `--font-display` (Space Grotesk), `--font-telugu`, `--text-xs` to `--text-3xl`, `--lh-*`, `--weight-*` |
| Shadow, glow, ring | `--shadow-sm/md/lg`, `--focus-ring`, `--focus-offset` |
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
- Bottom tab bar: glass, inactive muted, active white icon and label. No pill or underline.
- Player controls: transparent icon buttons, soft fill on hover, `--ring-neutral` on `:focus-visible`.
- Focus: `--glow-focus` cyan ring (cards also `scale(var(--focus-scale))`). Focus never uses the fill, so focus and selected look different.
- Disabled: 40% opacity, no glow.

## Page backdrop

Pages with hero art add the class `page-backdrop` to the art element. The art starts at y=0 behind a transparent header with a `--header-scrim` (black 70% to 0 over `--header-scrim-h`), and its bottom fades into `--color-bg`. Past 24px of scroll the header becomes the glass bar (`--glass-bg`, `--glass-blur`, hairline). Pages without a backdrop have a flat `--color-bg` page and the glass bar from the start. On phones (< 640px) the home hero is `--hero-height-phone` tall, the text stack is pinned to its bottom (one-line title, no synopsis) and `--hero-scrim-phone` fades the art into the page from halfway down.
