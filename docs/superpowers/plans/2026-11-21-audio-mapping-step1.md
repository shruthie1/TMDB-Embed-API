# Audio mapping Step 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry audio rendition identity through the stream contract, normalise language codes, build a two-way stream↔language index, and remove implicit pairing from the web player, so regular server/language selection is instant and never triggers a pair.

**Architecture:** The master-manifest parser already extracts rendition URIs (`hlsManifest.js` / `hybridStream.js` emit `{name, language, url, codecs}`), but the stream schema drops everything except `{language, codec, channels}`. Step 1 widens the `audio[]` contract to carry `{language, languageCode, name, uri, channels, codec, default}`, flows the manifest fields through `audioFromManifest`, and derives a two-way index on the client from the richer `audio[]`. The web player's implicit "pair a donor before a plain switch" block is deleted so a server switch only ever switches. The APK is not touched for pairing (it has no auto-pair-on-switch today).

**Tech Stack:** Node (CommonJS), Next.js/React web client, no new deps.

**Spec:** docs/superpowers/specs/2026-11-21-audio-pairing-design.md

## Global Constraints

- Never drop an audio/video/language tag to save latency (CLAUDE.md #1). Widening the contract only adds fields; no field is removed.
- Telugu-first ranking stays the point (CLAUDE.md #2); language normalisation must keep `tel`/`te`/`telugu` → `Telugu`.
- No auto-pairing anywhere, ever (spec principle 1).
- `audio[]` entry gains fields; the existing 3 (`language, codec, channels`) stay, same names.
- Do not disable `masterMatchesTitle` (CLAUDE.md #4). Do not sweep/benchmark newtv (CLAUDE.md #5).
- Git: main, no commit/push unless the user asks (CLAUDE.md #7). Plan steps say "commit" per TDD rhythm; actual commits wait for the user's go.
- No model passed to Agent tool; dispatch prompts carry the DO NOT DISPATCH preamble.

## Review Focus

- A stream whose `audio[]` is empty (most providers today): index must treat it as single-language from `languages[]`/top-level, not crash or show zero languages. (Task 3 tests.)
- A language present under different spellings across streams (`te` vs `Telugu`): the index must bucket them as one. (Task 2 + Task 3 tests.)
- A rendition with a URI but no LANGUAGE= (NAME-only): must still be selectable, keyed by name. (Task 1 tests.)
- Server switch to a source that lacks the current language: must switch cleanly and NOT attempt a pair (regression guard for the deletion). (Task 4 test.)
- `?capabilities=1` not sent (web/APK never send it today): index must work from the base contract, degrading to whole-stream language when renditions are absent. (Task 3 tests.)

---

### Task 1: Widen the audio[] contract in the stream schema

**Files:**
- Modify: `utils/streamSchema.js:164-170` (audio map), `:13-33` (field-contract header comment)
- Test: `utils/__tests__/streamSchema.audio.test.js` (create; match repo's existing test location — if none, `test/streamSchema.audio.test.js`)

**Interfaces:**
- Produces: each `audio[]` entry is `{ language, languageCode, name, uri, channels, codec, default }`. `language` = canonical display (unchanged), `languageCode` = raw code or null, `name` = rendition NAME or null, `uri` = resolved rendition URI or null, `default` = bool. Absent inputs → null/false; the three existing fields keep their current values.

- [ ] **Step 1: Write failing test** — `normaliseStream` with `audio:[{language:'tel', name:'Telugu', uri:'https://x/a.m3u8', codec:'mp4a', channels:2, default:true}]` yields entry `{language:'Telugu', languageCode:'tel', name:'Telugu', uri:'https://x/a.m3u8', codec:'mp4a', channels:2, default:true}`; and `audio:[{language:'en'}]` yields `uri:null, name:null, default:false`.
- [ ] **Step 2: Run, verify fail** — `node --test utils/__tests__/streamSchema.audio.test.js` (or the repo's test runner). Expected FAIL.
- [ ] **Step 3: Implement** — extend the `raw.audio.map` at `utils/streamSchema.js:164-170` to also read `languageCode` (from `t.languageCode || t.lang || t.language`), `name` (`t.name`), `uri` (`t.uri || t.url`), `default` (`Boolean(t.default ?? t.isDefault)`). Keep `language: canonicalLanguage(...)`, `codec`, `channels`. Update the header comment at `:20` to the 7-field shape.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git add utils/streamSchema.js utils/__tests__/streamSchema.audio.test.js` / `feat(schema): carry audio rendition identity`.

---

### Task 2: One shared language-normalisation helper (server) + align hybrid compare

**Files:**
- Modify: `lib/media/capabilities.js:25-37` (audioFromManifest emits `name` + `uri`), `utils/hybridStream.js:671-677` (defaultAudioIndex uses canonical compare)
- Test: `utils/__tests__/langKey.test.js` (create)

**Interfaces:**
- Consumes: `canonicalLanguage` from `utils/streamSchema.js` (existing export; confirm it is exported — if not, export it).
- Produces: `audioFromManifest` entries additionally carry `name` and `uri` (from `probe.audio[].name` / `.url`), so Task 1's schema receives them when `?capabilities=1`. `defaultAudioIndex` compares with `canonicalLanguage` instead of a 3-char prefix.

- [ ] **Step 1: Write failing test** — `canonicalLanguage('te') === 'Telugu'`, `canonicalLanguage('tel-IN') === 'Telugu'`, `canonicalLanguage('TELUGU') === 'Telugu'`, `canonicalLanguage('en') === 'English'` (or current behaviour), `canonicalLanguage(null) === null`. If a case fails, that is the gap to fix in `LANG_CANON`.
- [ ] **Step 2: Run, verify fail/pass per case** — fix only missing synonyms in `LANG_CANON` (`streamSchema.js:42-56`); do not change existing correct mappings.
- [ ] **Step 3a: Implement** — in `audioFromManifest` add `name: a.name || null, uri: a.url || a.uri || null` to each mapped entry. Confirm via `probe.js` what field holds the URI; if `probe.audio` lacks a URI field, flag it (see Open items) and emit `uri:null`.
- [ ] **Step 3b: Implement** — rewrite `defaultAudioIndex` compare (`hybridStream.js:672-675`) to `canonicalLanguage(r.language || r.name) === canonicalLanguage(PREFERRED_LANGUAGE)`; keep the `index 0` fallback.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(audio): flow rendition name/uri through capabilities; canonical lang compare in hybrid`.

---

### Task 3: Two-way stream↔language index (web, from audio[])

**Files:**
- Create: `web/lib/player/audioIndex.js`
- Test: `web/lib/player/__tests__/audioIndex.test.js` (create; match web test convention)

**Interfaces:**
- Consumes: the `audio[]` shape from Task 1 and `languages[]`/`selectableAudio` from the stream contract; `languageName`/`audioLanguageKey` from `web/lib/subtitles.js` / `web/lib/player/languageSources.js`.
- Produces: `buildAudioIndex(sources) → { byStream: Map<sourceId, Lang[]>, byLang: Map<langKey, {sourceId, rendition|null}[]>, langs: Lang[] }` where `Lang = {key, label}`; and `languagesForStream(index, sourceId) → Lang[]`, `streamsForLanguage(index, langKey) → {sourceId, rendition}[]`. A stream with non-empty `audio[]` contributes each rendition's language (rendition = `{uri,name,languageCode}`); a stream with empty `audio[]` contributes its `languages[]` (or single top-level language) with `rendition:null` (whole-stream).

- [ ] **Step 1: Write failing tests** — (a) two streams, one `audio:[{language:'te',uri:'a'}]`, other `audio:[{language:'Telugu',uri:'b'}]` → `byLang` has one Telugu bucket with both; (b) stream with `audio:[]`, `languages:['Hindi']` → Telugu absent, Hindi present with `rendition:null`; (c) rendition with `name:'Telugu'` no languageCode → bucketed Telugu; (d) empty input → empty maps, no throw.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `buildAudioIndex`, `languagesForStream`, `streamsForLanguage` using `audioLanguageKey` for bucketing. No network, pure.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(web): two-way stream/language audio index`.

---

### Task 4: Remove implicit pairing from the web server-switch path

**Files:**
- Modify: `web/components/Player.jsx:1595-1631` (delete the donor-pair block inside `switchSource`)
- Test: `web/components/__tests__/switchSource.test.js` (create if the component is testable in isolation; otherwise a focused unit test on the extracted switch logic — see Step 1 note)

**Interfaces:**
- Consumes: nothing new. After deletion, `switchSource` goes straight to the plain switch (`resolve.switchSource(src)` path at ~1633) regardless of whether the target owns the language.
- Produces: a server switch never calls `pickPairRef.current({mode:'pair',...})`.

- [ ] **Step 1: Write failing test** — assert that switching to a source lacking the wanted language does NOT invoke the pair callback. If `switchSource` cannot be unit-tested without a full player mount, instead add a guard test on a small extracted pure helper `shouldPair()` that Step 3 removes, OR document the manual repro (DevTools: switch server on a film with no Telugu in target; Network shows no `/hybrid/pair` call). Prefer the automated form; fall back to manual repro noted in the task if mounting is infeasible.
- [ ] **Step 2: Run, verify fail** (pair still fires today).
- [ ] **Step 3: Implement** — delete lines `1595-1631` (the `want`/`owns`/donor-selection/`pickPairRef` block). Leave the plain switch and the explicit single-rendition switch at `:1662` intact. Remove now-unused `carries`/`startupFallbackUsedRef` only if nothing else references them (grep first).
- [ ] **Step 4: Verify** — automated test passes, or manual repro shows no `/hybrid/pair` on server switch. Name the rung used.
- [ ] **Step 5: Commit** — `fix(web): server switch never triggers implicit pairing`.

---

### Task 5: Wire the index into the web server/language menu (render in-stream languages)

**Files:**
- Modify: `web/components/Player.jsx` (server menu render — the source list that today shows servers) and/or `web/components/player/overlays.jsx` / `TvBar.jsx` (whichever renders the choose-a-server list)
- Test: covered by Task 3's unit tests for the index; this task is render wiring, verified on the live surface.

**Interfaces:**
- Consumes: `buildAudioIndex` (Task 3). Each server row shows the languages that stream carries (`languagesForStream`). Selecting a language that exists in the current stream switches the in-stream rendition (existing `:1662` path); selecting one in another stream switches server then selects the rendition. No pairing from this menu.

- [ ] **Step 1: Build the index once per source list** (memoised on `sources`).
- [ ] **Step 2: Render per-server language labels** from `languagesForStream`.
- [ ] **Step 3: Wire language pick** → in-stream rendition switch if present, else `switchSource` to a stream from `streamsForLanguage` (no pair).
- [ ] **Step 4: Verify on the live web player** (desktop + TV): open a multi-audio film, server menu lists languages, picking one switches instantly, no `/hybrid/pair` call, picture doesn't reload. Name the rung (user-visible repro).
- [ ] **Step 5: Commit** — `feat(web): server/language menu lists in-stream audio, instant switch`.

---

### Task 6: Honest loading/switch copy — web (kill the misleading "server source slow")

**Files:**
- Modify: `web/lib/player/loadingModel.js` (the `FINDING_SLOW` phase + copy)
- Test: unit test on the phase/copy selection in `loadingModel.js`

**Interfaces:**
- Produces: a switch shows "Switching server…" while a known switch is in flight; "server source slow" appears ONLY when a genuine resolve exceeds the threshold with no switch pending. Pairing (explicit, Step 2) shows its own progress and its own failure line.

**Why:** "server is slow" on a switch is a lie — the delay is usually the implicit pair (removed in Task 4), not a slow server. The message is purely time-based today (`FINDING_SLOW` after `LOADING_SLOW_HINT_MS`). Separate "switching" from "slow" so the words match reality.

- [ ] **Step 1: Write failing test** — given state `{switching:true, elapsed > SLOW_MS}` the phase label is "Switching server…", not the slow text; given `{switching:false, elapsed > SLOW_MS}` it is the slow text.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add a `switching` input to the phase selection; return the switch label when switching, slow label only otherwise.
- [ ] **Step 4: Verify** — automated test passes; then on the live web player switch a server and confirm the overlay reads "Switching server…", not "slow". Name the rung.
- [ ] **Step 5: Commit** — `fix(web): honest switch vs slow copy`.

---

### Task 7: APK — one canonical language-compare rule

**Files:**
- Modify: `android/.../player/HybridPair.kt:82-89` (match + first-track fallback), `android/.../player/PlayerVm.kt:861-883` (`pickPreferredAudio` match 868-872), and the helpers `isoFor`/`langName` (`PlayerVm.kt:1323-1324`)
- Test: a Kotlin unit test on the canonical compare helper (`android/app/src/test/...`)

**Interfaces:**
- Produces: one `fun canonLang(raw: String?): String?` (or reuse an existing helper if one already canonicalises) used by both `HybridPair.matches` and `pickPreferredAudio.matches`, so `tel`/`te`/`telugu`/`Telugu`/`tel-IN` all compare equal, matching the server's `canonicalLanguage` and web's `audioLanguageKey`.

- [ ] **Step 1: Write failing test** — `canonLang("te") == canonLang("Telugu")`, `canonLang("tel-IN") == canonLang("telugu")`, distinct from English; null → null.
- [ ] **Step 2: Run, verify fail** — `cd android && ./gradlew testReleaseUnitTest --tests '*CanonLang*'` (or the module's test task). Expected FAIL.
- [ ] **Step 3: Implement** `canonLang`, route both match sites through it. Keep the first-supported-track fallback in `HybridPair` (do not change pairing behaviour — that is Step 2), only the language equality test.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(apk): one canonical audio-language compare`.

---

### Task 8: APK — two-way index + in-stream language menu

**Files:**
- Create/Modify: a Kotlin audio-index helper (mirror of `web/lib/player/audioIndex.js`), likely in `android/.../data/` or `.../player/`; wire it into the TV + phone server/language menu composable (find the server-list UI in `ui/tv/TvApp.kt` and the phone player UI).
- Test: Kotlin unit test on the index builder.

**Interfaces:**
- Consumes: the richer `audio[]` from Task 1 (APK model gains `uri`/`name`/`languageCode`/`default` — update `data/Models.kt` audio model to match the contract), and Task 7's `canonLang`.
- Produces: `buildAudioIndex(sources)` → stream→langs and lang→streams, same semantics as Task 3 (empty `audio[]` → whole-stream from `languages`). The server menu lists per-stream languages; picking a language selects the in-stream track (existing `pickPreferredAudio`/track-override path) or switches server, never pairs.

- [ ] **Step 1: Write failing test** — same four cases as Task 3 (cross-spelling bucketing, empty-audio whole-stream, NAME-only, empty input), in Kotlin.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the index + extend `data/Models.kt` audio model + wire the menu (TV via D-pad focus list, phone via tap). Picking a language → in-stream track override if present, else switch source; no pair call.
- [ ] **Step 4: Verify** — unit test passes; then install on Fire TV + phone (check mCurrentFocus ≠ com.chitram.app before install; cert 54d3b35…e6ed0ee3) and confirm the menu lists languages and switches instantly with no pairing. Name the rung (device repro).
- [ ] **Step 5: Commit** — `feat(apk): two-way audio index + in-stream language menu`.

---

### Task 9: APK — honest switch vs slow copy

**Files:**
- Modify: `android/.../player/LoadingModel.kt` (the Kotlin mirror of `loadingModel.js` FINDING_SLOW)
- Test: Kotlin unit test on the phase/copy selection.

**Interfaces:**
- Consumes: a `switching` flag on the loading state (set when a known source switch is in flight).
- Produces: "Switching server…" while switching; the slow text only on a genuine slow resolve. Mirrors Task 6 exactly (same copy strings).

- [ ] **Step 1: Write failing test** — `{switching:true, elapsed>SLOW}` → switch label; `{switching:false, elapsed>SLOW}` → slow label.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add `switching` to the phase selection, same label strings as Task 6.
- [ ] **Step 4: Verify** — unit test passes; on device, switch a server and confirm the overlay/text reads "Switching server…", not "slow". (APK shows loading TEXT, not skeletons — confirm the text line.) Name the rung.
- [ ] **Step 5: Commit** — `fix(apk): honest switch vs slow copy`.

---

## Open items (flag before/while building)

- `probe.audio` field shape (`lib/media/probe.js`) — confirm it carries the rendition URI so Task 2 Step 3a can emit `uri`. If it drops the URI, Task 2 must thread `url` from `hlsManifest.parseAudioRenditions` through `probe` first. Read `probe.js` at build time.
- APK: no implicit-pair-on-switch exists today (confirmed), so Step 1 does not touch APK pairing. APK gains the richer `audio[]` automatically via the contract; mirroring the index in Kotlin is Step 1.5/Step 2 scope, deferred unless the user wants APK language-menu parity now.
- Web test harness: confirm how web unit tests run in this repo (jest? node:test? none?) before Task 3/4 test steps; adapt the runner command.
