# Audio pairing Step 2: "Add <L> audio" journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One explicit, on-tap "Add <L> audio from another server" journey, identical on web (desktop, phone, Fire TV Silk) and APK (phone, Fire TV), that keeps the playing picture, checks donors only after the tap, and leaves playback untouched when none works.

**Architecture:** Both clients use the existing server gate, `POST /hybrid/pair`, as the on-tap donor check. The server learns the wanted language: it refuses a donor without L and makes L the DEFAULT rendition. A small pure module per client builds the offers and the donor order, and runs at most 3 donors in 30 s. A try counts as good only when the device plays the pair; a device failure moves to the next donor. When every donor fails, the previous stream, position and audio come back with one notice. The APK uses the server-fused pair when the backend answers, and the on-device merge (`HybridPair`) only when the backend is unreachable (owner 2026-11-21).

**Tech Stack:** Node (CommonJS, node --test), Next.js/React (vitest), Kotlin/media3 (JUnit via gradle). No new deps.

**Spec:** docs/superpowers/specs/2026-11-21-audio-pairing-design.md
**Survey:** .superpowers/sdd/2026-11-21-audio-pairing-step2/survey.md (file:line evidence for every reuse below)

## Global Constraints

- Pairing never starts automatically. Only a tap on the entry calls `/hybrid/pair` (spec principle 1).
- One entry per language that is missing from the playing stream and that another server carries as a selectable track. Show every such language: Telugu first, then the Step 1 index order. No donor is probed before the tap (spec "Decided").
- Fixed-audio servers (whole-stream audio, `selectableAudio` false) are never donors and never make an entry.
- Device fails to play an accepted pair: try the next donor inside the same caps. All donors spent: restore the previous stream, position and audio, then show `noWorkingAudio`.
- APK: server-fused first; on-device merge only when the backend is unreachable. The on-device merge refuses a duration delta over 15 s (server `DURATION_TOLERANCE_SECONDS`, `utils/hybridStream.js:48`), picks only an L track, and never plays the donor alone.
- On failure: position, picture, `wantLang`/`selectedAudioLanguage` and the selected track are unchanged.
- Never fall back to track 0 or another language when L is asked for (CLAUDE.md #1).
- Donor order is Telugu-first ranking (the server list order), then the Step 1 index (CLAUDE.md #2).
- Copy strings are byte-equal in `web/lib/player/loadingModel.js` `Copy` and `player/LoadingModel.kt` `Copy`.
- Fire TV Silk is Chrome 70: no flex `gap`, no `:has()`, no `min()` in new CSS. On TV every entry is D-pad reachable and the list scrolls inside the menu (web TvBar and APK sheet).
- Do not disable `masterMatchesTitle` (`providers/netmirror.js:613`, called at `:934`).
- Limits: `ADD_AUDIO_MAX_TRIES = 3`, `ADD_AUDIO_TRY_MS = 15000`, `ADD_AUDIO_TOTAL_MS = 30000`, same names and values on web and APK.
- Git: main, no commit or push unless the user asks (CLAUDE.md #7). "Commit" steps wait for that go.

### Copy (final, 2026-11-21; `…` is U+2026)

| Key | Text |
|---|---|
| `ADD_AUDIO_GROUP` | `Add audio from another server` |
| `addAudio(lang)` | `Add ${lang} audio from another server` |
| `checkingAudio(lang, server, n, total)` | `Checking ${server} for ${lang} audio (${n} of ${total})…` |
| `audioAdded(lang, server)` | `${lang} audio added from ${server}.` |
| `noWorkingAudio(lang)` | `No server has working ${lang} audio. Playback is unchanged.` |

### Why 3 tries, 15 s, 30 s

- A cold try is about 8 sequential provider round trips; each fetch may wait `FETCH_TIMEOUT_MS = 12000` (`utils/hybridStream.js:77`). 15 s covers one full fetch timeout plus a normal try.
- Later tries reuse the cached video description (`DESCRIBE_TTL_MS` 10 min, `:393`), so they are about 5 round trips.
- 30 s equals `LOADING_CHOOSER_MS` and `LOADING_RETRY_MS` (`web/lib/player/loadingModel.js:13-14`): the longest wait the player already asks of the viewer.
- 3 tries x 15 s exceeds 30 s on purpose: the total budget stops the run, the try cap stops a fast run of 409s from hitting every server.
- Latency numbers are from code, not measured. Task 7 measures one real tap.

## Review Focus

- Donor has renditions but none in L (server says 200 today and plays Telugu): must be a 409 and the next donor. (Task 1.)
- Second tap while a check runs: must show the in-flight progress, not start a second run. (Tasks 3, 5.)
- Paired stream passes the server check, then fails to play on the device: the next donor is tried inside the caps; when all are spent, previous stream, position and language come back and the notice says `noWorkingAudio`. (Tasks 3, 4, 5, 6.)
- APK on-device merge: duration delta over 15 s refused; no L track means no pair (no first-track fallback); an error never leaves the donor playing alone. (Task 6.)
- Fire TV Silk native path has no audio track API: the paired master must open on L (server DEFAULT). (Task 1, Task 4 TvBar test.)
- APK row resolved on the phone (`onDevice != null`): the server holds no headers for it, so the server-fused path never uses it. Ruling: the on-device merge CAN serve it (the device holds `Source.headers`), so such a row is a donor, and a playing on-device row gets an entry, only on the on-device path. A pair with an on-device half skips `/hybrid/pair` and goes straight to the on-device merge. (Tasks 5, 6.)

---

### Task 1: Server: `language` on `/hybrid/pair`

**Files:**
- Modify: `lib/media/hybridRoutes.js:119-266`, `utils/hybridStream.js:672-678` (`defaultAudioIndex`), `:687` (`buildMaster`), `:839` (`planId`)
- Test: `test/hybridPairLanguage.test.js` (create; reuse `stubFetch`, `fakeApp`, `postPair` pattern from `test/hybridAudioPairing.test.js:30-58`)

**Interfaces:**
- Produces: body accepts optional `language` (string). With it: 409 `{error:'not pairable', reason:'the audio source has no <L> audio track', audioRenditions}` when no donor rendition matches by `canonicalLanguage(language|name)`; else 200 as today, master `DEFAULT=YES` on the L rendition. `defaultAudioIndex(renditions, language = PREFERRED_LANGUAGE)`. `planId` hashes `video|audio|nudge|language`. Without `language`, behaviour is unchanged.

- [ ] **Step 1: Write failing tests**: (a) donor master with Telugu+Hindi renditions, `language:'Hindi'` → 200, master line for Hindi has `DEFAULT=YES`, Telugu `DEFAULT=NO`, all renditions still present; (b) donor with Telugu+Tamil, `language:'Hindi'` → 409, `reason` contains `no Hindi audio`; (c) `language:'te'` matches a `LANGUAGE="tel"` rendition; (d) no `language` → Telugu default, same `planId` as before; (e) same urls, two languages → different `planId`.
- [ ] **Step 2: Run, verify fail**: `node --test test/hybridPairLanguage.test.js`. Expected: (a)(b)(c)(e) FAIL.
- [ ] **Step 3: Implement**: check the language after the viewer-roles `plan` is found (`hybridRoutes.js:176`), before `realisePlan`; set `plan.language`; pass it through `realisePlan` to `buildMaster` → `defaultAudioIndex`. Keep the existing 409 diagnostics.
- [ ] **Step 4: Run all server tests**: `node --test test/*.test.js`. Expected: baseline 469 pass + new, 0 fail.
- [ ] **Step 5: Commit**: `feat(hybrid): pair checks and defaults the asked language`.

---

### Task 2: Copy and limits, byte-equal on both clients

**Files:**
- Modify: `web/lib/player/loadingModel.js:58` (`Copy`), `android/app/src/main/java/com/chitram/app/player/LoadingModel.kt:43` (`Copy`)
- Test: `web/test/loadingModel.test.js`, `android/app/src/test/java/com/chitram/app/SwitchCopyGuardTest.kt` (extend the `:93` web-source check)

**Interfaces:**
- Produces: the 5 Copy keys in the table above; constants `ADD_AUDIO_MAX_TRIES`, `ADD_AUDIO_TRY_MS`, `ADD_AUDIO_TOTAL_MS` exported from both files.

- [ ] **Step 1: Write failing tests**: web: `Copy.ADD_AUDIO_GROUP === 'Add audio from another server'`, `Copy.addAudio('Telugu') === 'Add Telugu audio from another server'`, `Copy.checkingAudio('Telugu','CastleTV',1,3) === 'Checking CastleTV for Telugu audio (1 of 3)…'`, `Copy.audioAdded('Telugu','CastleTV') === 'Telugu audio added from CastleTV.'`, `Copy.noWorkingAudio('Telugu') === 'No server has working Telugu audio. Playback is unchanged.'`. APK: same asserts, plus `web.contains(...)` for each template literal and each constant line.
- [ ] **Step 2: Run, verify fail**: `cd web && npx vitest run test/loadingModel.test.js`; `cd android && ./gradlew --no-daemon testReleaseUnitTest --tests '*SwitchCopyGuardTest*'` (with `JAVA_HOME` set as in the runner note).
- [ ] **Step 3: Implement** the keys and constants.
- [ ] **Step 4: Run, verify pass** (same commands).
- [ ] **Step 5: Commit**: `feat(copy): add-audio strings, byte-equal web and APK`.

---

### Task 3: Web model: offers, donor order, bounded run

**Files:**
- Create: `web/lib/player/addAudio.js`
- Test: `web/test/addAudio.test.js`

**Interfaces:**
- Consumes: `languageSourceIndex`, `audioLanguageKey`, `trackAudioLanguage` (`web/lib/player/languageSources.js`); Task 2 constants.
- Produces:
  - `addAudioOffers(sources, playing, audioTracks) → {language, donors: Source[]}[]`: one per L in the index that no `audioTracks` entry (or, with no tracks, the playing row's languages) carries and that has ≥1 donor. Every such L, no cap. Order: Telugu first, then the Step 1 index order.
  - `pairDonors(sources, language, playing, failed = new Set()) → Source[]`: index rows for L, excluding the playing row, `unsupported`, `hybrid`, rows of the playing provider (server refuses same provider), rows without `selectableAudio` (server needs `EXT-X-MEDIA` renditions), and ids in `failed`. Order: rows whose `audio[]` has an L rendition with a `uri` first, then the rest; inside each, the index order (server Telugu-first rank). Max `ADD_AUDIO_MAX_TRIES`.
  - `tryDonors({donors, tryOne, onTry, now = Date.now, totalMs = ADD_AUDIO_TOTAL_MS, tryMs = ADD_AUDIO_TRY_MS}) → Promise<{donor, result} | {failed: Source[]}>`: calls `tryOne(donor, signal)` in order; each with an `AbortSignal` that fires at `min(tryMs, remaining)`; stops at the first non-null result or when the total budget is spent.
  - `createAddAudioRun({language, donors, startedAt})`: run state holding `tried`, `startedAt` and the remaining donors, so a device failure after a 200 continues with the next donor inside the same 3-donor, 30 s caps. `next()` returns the remaining donors and budget, or null when spent.

- [ ] **Step 1: Write failing tests**: offers skip L present in `audioTracks` (`te` vs `Telugu` is one key); offers empty when only the playing provider lists L; donor order puts a `uri` rendition row before a languages-only row; cap at 3 from 5 rows; offers list every missing L, Telugu first, rest in index order; a `selectableAudio:false` row makes no offer and is no donor; a run that spent 2 donors and 20 s has 1 donor and 10 s left; `tryDonors` with `[null, null, ok]` returns the 3rd; with a never-resolving `tryOne` and fake clock, aborts and returns `{failed}` after 30 000 ms total; `onTry` receives `(donor, n, total)`.
- [ ] **Step 2: Run, verify fail**: `cd web && npx vitest run test/addAudio.test.js`.
- [ ] **Step 3: Implement** the four functions.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit**: `feat(web): add-audio offers and bounded donor run`.

---

### Task 4: Web wiring: entry in both menus, on-tap check, clean failure

**Files:**
- Modify: `web/lib/backend.js:462` (`pairSources` sends `opts.language`), `web/components/Player.jsx:1642-1754` (split `pickPair`), `web/components/PlayerControls.jsx:281-295`, `:638-676`, `web/components/player/AudioMenu.jsx`, `web/components/player/TvBar.jsx:189-198`, `:282-300`, `web/app/globals.css` (TvBar add-audio list)
- Test: `web/test/addAudioPlayer.test.js` (create), extend `web/test/switchNoAutoPair.test.js`

**Interfaces:**
- Consumes: Task 1 `language` body field; Task 3 functions; Task 2 Copy.
- Produces: `Player.jsx` `addAudio(language)`: no-op with notice `checkingAudio` text if a run is in flight; otherwise runs `tryDonors` with `tryOne = (donor, signal) => checkPair(video, donor, language, signal)`, where `checkPair` = `pairSources` + `pairDecodable !== false`. On success calls `applyPair(video, donor, language, paired)`: the existing tail of `pickPair` (`:1680-1695`) plus `setWantLang(language)` moved here. On `{failed}` before any switch: `setNotice(Copy.noWorkingAudio(language))`, no other state change. Snapshot (stream, position, `wantLang`, track) once, at the first `applyPair` of the run. A pair that fails to play on the device (fatal error or no start within the try time) calls the run's `next()` and tries the next donor. When `next()` is null: restore the snapshot via `switchGuard`, then `setNotice(Copy.noWorkingAudio(language))`. New prop `onAddAudio(language)` on PlayerControls and TvBar.
- Progress uses `setNotice(Copy.checkingAudio(...))` per try, not `beginSwitch` (its 12 s backstop clears the label mid-run, `Player.jsx:1370`).
- Menu: `AudioMenu` gets a trailing group titled `Copy.ADD_AUDIO_GROUP`, one row per offer labelled `Copy.addAudio(L)`. It already scrolls (`.pmenu-sheet-body`, `globals.css:3161`). TvBar gets one more `tvbar-row` with the same rows as `tvbar-btn focusable` buttons inside a `.tvbar-add` box with `max-height` and `overflow-y:auto`; D-pad focus already scrolls into view (`web/lib/dpad.js:302`). New CSS uses margin, not `gap`.

- [ ] **Step 1: Write failing tests**: (a) `pairSources(v, a, {language:'Hindi'})` posts `language:'Hindi'`; (b) with a stub `pairSources` returning null for all donors, `addAudio('Hindi')` leaves `wantLang`, `currentSourceId` and `videoRef.currentTime` unchanged and shows `No server has working Hindi audio. Playback is unchanged.`; (c) second donor passes the server check → `switchSource` called once with `masterUrl` from the pair answer and `hybrid:true`; (d) `pairDecodable` false counts as a failed try; (e) PlayerControls and TvBar render `Add Hindi audio from another server` when the playing stream lacks Hindi and another `selectableAudio` row lists it, and not when it carries Hindi; (e2) with 4 missing languages, all 4 entries render, Telugu first, and the TvBar list is inside `.tvbar-add`; (e3) first accepted pair fires a fatal error → the second donor is tried, no restore yet; (e4) all donors fail on the device → stream, position and `wantLang` equal the snapshot and the notice is `noWorkingAudio`; (f) `switchNoAutoPair`: mounting, a server pick and a language pick make zero `/hybrid/pair` calls.
- [ ] **Step 2: Run, verify fail**: `cd web && npx vitest run test/addAudioPlayer.test.js test/switchNoAutoPair.test.js test/components/tvBarLayout.test.jsx`.
- [ ] **Step 3: Implement** as in Interfaces. Leave `commitAudioSync` (`:1818`) on `lastPair` as is; set `lastPair` in `applyPair`.
- [ ] **Step 4: Run full web suite**: `cd web && npx vitest run`. Expected: 1016 baseline + new, 0 fail.
- [ ] **Step 5: Commit**: `feat(web): explicit Add <L> audio journey`.

---

### Task 5: APK: server-fused journey on PlayerVm and the audio sheet

**Files:**
- Create: `android/app/src/main/java/com/chitram/app/player/AddAudio.kt`
- Modify: `data/Api.kt` (add `pair`), `player/PlayerVm.kt:80`, `:521`, `:605-613`, `:1197`, `:1275-1323`
- Test: `android/app/src/test/java/com/chitram/app/AddAudioTest.kt` (create)

**Interfaces:**
- Consumes: Task 1 body; Task 2 Copy and constants.
- Produces:
  - `AddAudio.offers(sources, current, carried: Set<String>): List<Pair<String, List<Source>>>` and `AddAudio.donors(sources, language, current, failed): List<Source>`: same rules and order as web Task 3 (every missing L, Telugu first, then index order; `selectableAudio` false excluded). Rows with `onDevice != null` are excluded here; Task 6 adds them for the on-device path.
  - `suspend fun AddAudio.run(donors, tryOne: suspend (Source) -> PairOutcome, onTry: (Source, Int, Int) -> Unit, clock)` with `withTimeoutOrNull` per try and total. Run state keeps `tried` and the start time so a device failure continues with the next donor inside the same caps.
  - `Api.pair(video, audio, language, tmdbId, type): PairOutcome`, sealed: `Ok(url, codecs, padded, delta)`, `Refused` (409), `Unreachable` (IO error, timeout, 5xx). Task 6 uses `Unreachable`.
  - Menu: `audioMenu` emits `MenuItem("add:$lang", Copy.addAudio(lang), group = Copy.ADD_AUDIO_GROUP)` after `OTHER_SERVERS`, one per offer. The sheet is a `LazyColumn` (`ui/common/PlayerScreen.kt:497`), so a long list scrolls and stays D-pad reachable.
  - `choose("add:<L>")`: if a run is active, `notice = checkingAudio(...)` of that run and return. Else launch in `viewModelScope`; per try `notice = Copy.checkingAudio(...)`; skip a result whose `codecs` the device cannot decode (`CodecSupport.supports` + `HybridPair.audioDecodes`). On `Ok`: at the first success of the run store `pairFallback = Triple(current, selectedAudioLanguage, position)`; play through the reused `"pair"` branch (`:1197`), changed to take the paired url and the tapped L instead of `prefs.preferredAudio()`; `notice = Copy.audioAdded(L, label(a))`. Run spent with no play: `notice = Copy.noWorkingAudio(L)`, nothing else.
  - `handleError`: when the failing row is the run's pair, try the next donor; when none is left, `play(prev, pos, audioLanguage = prevLang)` and `notice = Copy.noWorkingAudio(L)`. The old `pairedAudio` branch (`:606-612`) no longer plays the donor alone.

- [ ] **Step 1: Write failing tests**: offers and donor order cases mirroring Task 3 (incl. `te`/`tel`/`Telugu` one key, every missing L listed Telugu first, `selectableAudio` false excluded, on-device rows excluded, cap 3); `run` returns the 2nd result after a `Refused`; `run` gives null after 30 000 ms on a stalled `tryOne` (use `runTest` virtual time); `audioMenu` lists `add:Hindi` with label `Add Hindi audio from another server` under `Add audio from another server` and never lists `add:` for a language in the stream; a device error on the first pair tries the second donor; all donors failing restores `pairFallback` and shows `noWorkingAudio`; a pair error never plays the donor row alone.
- [ ] **Step 2: Run, verify fail**: `export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"; cd android && ./gradlew --no-daemon testReleaseUnitTest --tests '*AddAudioTest*'`.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run full APK suite**: same command without `--tests`. Expected: 284 baseline + new, 0 fail, 5 skipped.
- [ ] **Step 5: Commit**: `feat(apk): explicit Add <L> audio journey`.

---

### Task 6: APK: on-device merge fallback

**Files:**
- Modify: `player/HybridPair.kt:35-90`, `player/AddAudio.kt`, `player/PlayerVm.kt` (run's `tryOne`)
- Test: `android/app/src/test/java/com/chitram/app/HybridPairFallbackTest.kt` (create); extend `SwitchCopyGuardTest.kt` with the tolerance guard

**Interfaces:**
- Consumes: Task 5 `PairOutcome.Unreachable`, run state.
- Produces:
  - When `Api.pair` returns `Unreachable`, or either half has `onDevice != null`, the try uses the on-device merge for that donor. `AddAudio.donors(..., onDevicePath = true)` then also allows `onDevice` rows. A playing `onDevice` row gets offers from this path.
  - `HybridPair.DURATION_TOLERANCE_S = 15`, equal to server `DURATION_TOLERANCE_SECONDS` (`utils/hybridStream.js:48`). Before merging, read each half's media playlist with the row's own headers, sum `#EXTINF`, refuse when the delta is over 15 s. No padded rule: the device has no offset correction (`OFFSET_US = 0`).
  - `HybridPair.overrides` returns null when no audio track matches L: delete the any-track fallback (`:87`). Null means a failed try, so the run moves to the next donor.
  - A merged pair that errors goes to the Task 5 `handleError` path: next donor or restore. Never the donor alone.
  - Delete nothing else. `candidate()` stays unused; `AUDIO_HALVES` does not limit the fallback donors.

- [ ] **Step 1: Write failing tests**: (a) playlists of 7200 s and 7216 s → refused; 7200 s and 7210 s → accepted; (b) `overrides` with Hindi and Tamil tracks and `want = Telugu` → null; with a Telugu track → that track; (c) `Unreachable` from `tryOne` → the on-device merge runs for the same donor; `Refused` → it does not; (d) merged-pair error → next donor, and the last restores `pairFallback`, never `play(donor)`; (e) guard: `utils/hybridStream.js` contains `|| 15;` on the `DURATION_TOLERANCE_SECONDS` line and `HybridPair.DURATION_TOLERANCE_S == 15`.
- [ ] **Step 2: Run, verify fail**: `cd android && ./gradlew --no-daemon testReleaseUnitTest --tests '*HybridPairFallbackTest*' --tests '*SwitchCopyGuardTest*'` (with `JAVA_HOME` set).
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run full APK suite**: expected Task 5 total + new, 0 fail, 5 skipped.
- [ ] **Step 5: Commit**: `feat(apk): on-device add-audio fallback, duration and language gate`.

---

### Task 7: Live check, one title, both surfaces

**Files:** none changed.

- [ ] **Step 1:** Start the API locally (see AGENTS.md). Pick one title where the playing stream lacks Telugu and a CastleTV/NetMirror row lists it. ONE tap, not a sweep (CLAUDE.md #5).
- [ ] **Step 2:** Web desktop: tap the entry; grep `tr '\r' '\n' < /tmp/api8790.log | grep -a '\[hybrid/pair\]'` for the request count, and note seconds from tap to `audioAdded` or `noWorkingAudio`.
- [ ] **Step 3:** Web phone width, Fire TV Silk, APK phone, APK Fire TV with D-pad: same tap. Record copy seen, position before and after, audio language after.
- [ ] **Step 4:** Force failure (a title with no donor that has L): confirm `noWorkingAudio` and that position, picture and language are unchanged.
- [ ] **Step 5:** APK with the API stopped: same tap uses the on-device merge, or shows `noWorkingAudio` with playback unchanged.
- [ ] **Step 6:** Report each surface as verified or unverified with the reason. Feed the measured try time back into the 15 s / 30 s numbers.
