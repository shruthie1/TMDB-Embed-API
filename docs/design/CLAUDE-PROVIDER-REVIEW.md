# Claude design consultation

2026-11-21. Produced by the locally installed Claude Code CLI2.1.329, print mode,
tools and hooks disabled; supplied sanitized source/design context only.
No app source edits or provider requests were delegated to Claude.

## Maintainer corrections

- The raw review below incorrectly says independent NetMirror catalog selection
  is supported today. The source audit establishes dynamic discovery, but the
  generic resolver currently fans out catalogs. A selected-entry contract is
  required before those subgroups can behave independently.
- Startup is parallel for eligible client-supported providers, not serial.
- Browser-direct support must be demonstrated per provider; metadata-only API
  descriptors are not provider checks. No VM resolution fallback is allowed.
- Existing token CSS is authoritative when older token documentation differs.
  Touch targets should be at least44px using existing spacing tokens.

## Raw design review

# Chitram provider/stream selection: design recommendation

## 1. Hierarchy and interaction

One menu, three levels, collapsing automatically.

**Level 1 Server (always shown).** A stable list of enabled providers from `/api/providers`, rendered before any resolve. Each row carries a state, never a bare `Server 1`. Order comes from measured client outcomes, not static claims. The list never reshuffles while results land, and never hides because only one stream exists.

**Level 2 Subgroup (conditional).** Show a child list only where the resolver honors an independent selection: today that is NetMirror catalogs (Netflix, Prime Video, Hotstar, dub catalogs). Videasy, ZXCStreams and Mapple fan out internally and return a winner, so they stay single rows until a selection contract exists. A subgroup row uses a `chevron` disclosure; collapsed by default, expanded on demand.

**Level 3 Stream/release (conditional).** List real variants only when the provider returns meaningful alternatives (distinct files, releases, named upstream servers like VidRock Nova/Atlas). Do not add a row per signed-URL refresh. When only opaque options exist, `Alternative 1/2` with a real quality and language summary is the floor.

**Single source:** no Level 3. The row resolves and transfers `Playing` directly.

**Multi source:** expand to Level 3 on select; existing playback continues.

**Parallel startup (Auto):**
- Render rows plus remembered audio immediately. The remembered provider never overrides Telugu-first.
- Fire eligible client-supported lookups concurrently. Unsupported clients make no request. Nothing routes through the VM.
- Play the first confirmed-Telugu playable stream at once.
- 15s soft window: if no Telugu, start the best usable stream and name its real language. If nothing is usable, keep honest loading plus Retry plus Server choices. Never promise playback at second 15.
- A late Telugu result becomes a `Switch to Telugu` offer, never a forced cut. Opening the menu triggers no new checks.

## 2. Layout anatomy (existing tokens)

Reuse the player menu primitives: `.pmenu`, `.pmenu-group`, `.pmenu-label`, `.pmenu-item`, `.pmenu-text`, `.pmenu-meta`, `.pmenu-spin`. One ring only, `--focus-ring` at `--focus-offset`.

**Desktop web (`min-width:720px`).** Anchored menu off the control row, `.pmenu` pattern: `--color-surface-3` fill, `--color-border`, `--radius-lg`, `--blur-glass`, `--shadow-lg`. Width `min-width:186px` floor, cap near `320px`. Row height from `--pmenu-item` padding (`--space-2`/`--space-3-5`), `--control-h` 34 for the trigger chips. Four triggers in order: Server, Audio, Quality, Subtitles. `max-height:min(58vh,420px)`, scroll contained.

**Android phone portrait (`<720px`).** Bottom sheet, `--radius-lg` top corners, `--glass-bg`, safe-area pad `--safe-b`. Touch rows at `--btn-h-phone` 40 min. No dismiss on Check: selecting a row keeps the sheet open. Server, Audio, Quality, Subtitles stack as `.pmenu-group` sections with `--pmenu-label` headers.

**Phone landscape.** Compact right side panel, `--z-panel`, width ~`320px`, full height, so the frame stays visible. Same rows, same states.

**Desktop/phone shared:** trigger icons sit in `.pctl-row` (`gap:var(--space-1)`), transparent icon buttons, soft fill on hover, `--ring-neutral` on focus-visible.

**Android TV / TV browser (`[data-tv="true"]`).** Large right panel, `--z-panel`, `--glass-bg` 85% with `--glass-blur:none`. Rows at `--control-h` 44, `.pmenu-item` font 16, pad `--space-3`/`--space-4-5`, `min-width:250px`. D-pad: the selected (or Playing) row takes initial focus. Back walks child → provider → playback. Focus is the 3px white `--focus-ring` plus `--focus-glow`; `--focus-scale` 1.04 on rows. No hover state substitutes for focus.

All surfaces share one state model, one order, one copy set. Geometry differs; meaning does not.

## 3. Icon map (Icon.jsx names only)

| Element | Icon name |
|---|---|
| Server trigger/level | `server` |
| Audio control | `audio` |
| Quality control | `quality` |
| Subtitles control | `subtitles` |
| Subgroup disclosure | `chevron` |
| Playing / selected tick | `check` |
| Retry an entry | `restart` |
| Slow / soft-window pending | `clock` |
| Embedded provider player (opens) | `play` |
| Load more / partial result | `plus` |
| TV Back navigation | `back` |
| Close sheet/panel | `close` |
| More settings overflow | `settings` |

**Checking** uses the existing CSS `.pmenu-spin` (reuses `pspin`), not an icon; under `prefers-reduced-motion` it freezes and the `Checking…` label carries the state. The set has **no glyph** for warning, lock/sign-in, or unsupported-device. Do not invent or substitute emoji or a foreign icon pack. Render those states as text with a status line colour (`--color-warn-line`, `--color-danger-line`) and keep the row otherwise glyph-free. `offline` stays reserved for network loss, not for `Not supported in this browser`.

## 4. Gaps and the recommendation

**Gaps in the current proposal:**
- No stable identity. `normaliseStream` collapses source to provider/title/URL and drops server, rendition and `statedLanguage`. Persistent selection needs `providerId + entryId + streamId`.
- Showbox emits `Febbox Direct`/`Febbox FID`; the registry ID is `showbox`. Label cannot be the key.
- `/api/providers` returns only name and enabled: no display name, no capability, no per-client mode.
- Icon set lacks sign-in, warning and unsupported glyphs.
- Android keeps multiple rows only for NetMirror; backend may return more for Castle/VaPlayer. Inventory is unequal per surface.
- Vixsrc parses then discards audio and captions; badges would lie.

**Recommendation (single path):** Ship the stable all-provider Server list plus current-stream Audio/Quality/Subtitles controls first, driven by the four existing `.pmenu` triggers. Treat every untried provider as a `Not checked` request target, resolved lazily on the viewer client. Expose subgroups and Level 3 streams only where a resolver already honors independent selection (NetMirror catalogs today). Everything else stays a single row until the selection contract and capability catalog exist. This matches every USER DECISION and claims no browser support without proof.

**Alternative, only if backend lands first:** promote Videasy/ZXC/Mapple subgroups once each resolver accepts a selected `entryId`. Hold until then.

## 5. Reuse checklist and approvals

**Reuse checklist:**
- Menu shell: `.pmenu`, `.pmenu-group`, `.pmenu-label`, `.pmenu-item`, `.pmenu-text`, `.pmenu-meta`.
- Spinner: `.pmenu-spin` / `pspin`, reduced-motion fallback included.
- Triggers: `.pctl-row`, `.pctl-quality` chip pattern, `--control-h`.
- Tokens only: `--color-surface-3`, `--color-border(-hover)`, `--radius-lg`/`-sm`, `--glass-bg`, `--blur-glass`, `--shadow-lg`, `--space-*`, `--focus-ring`, `--focus-scale`, `--z-panel`.
- Status colour: `--color-success-line`, `--color-warn-line`, `--color-danger-line` only.
- Icons: names in section 3; no new glyphs except the three true gaps.
- TV: change via `[data-tv="true"]` block, no component overrides.

**Approval decisions (max 8):**
1. Ship Server list plus current-stream Audio/Quality/Subtitles first; subgroups later.
2. Approve `Not checked` as the default provider state, lazy resolve on client.
3. Approve `providerId + entryId + streamId` identity as a prerequisite.
4. Approve the 15s soft window behaviour and truthful fallback language.
5. Approve late Telugu as `Switch to Telugu` offer, never forced.
6. Approve text-only treatment for sign-in, warning and unsupported states, or authorise three new Icon.jsx glyphs.
7. Approve NetMirror catalogs as the only Level 2 subgroup for launch.
8. Approve the single shared state model across phone, desktop and TV.

No browser-direct provider support is asserted here. Capability testing must precede any `Supported` label.
