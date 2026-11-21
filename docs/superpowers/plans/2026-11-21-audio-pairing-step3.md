# Audio pairing Step 3: language-filtered entries, mp4 pairing, offset measurement, stream-down recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the stuck spinner after a stream dies, show Add entries and other-server rows only for the viewer's languages, pair mp4 pictures on the APK, and make `/hybrid/pair` explain every refusal and pair different cuts at a measured offset.

**Architecture:** Web and APK each read the stored "Your languages" list once per menu build and filter the Step 2 offers and the "Other servers" rows with it. The server keeps `/hybrid/pair` as the on-tap gate. It refuses an mp4 video half up front, logs one `[pair-gate]` line per branch, and, when the lengths differ beyond 15 s, runs a bounded ffmpeg envelope cross-correlation at three points to find the offset. The APK on-device merge gains an mp4 length reader (`moov/mvhd`) so a progressive picture can merge with a donor HLS audio rendition.

**Tech Stack:** Node (CommonJS, node --test, ffmpeg on the VM), Next.js/React (vitest), Kotlin/media3 (JUnit via gradle). No new deps.

**Spec:** docs/superpowers/specs/2026-11-21-audio-pairing-design.md (section "Step 3")
**Evidence:** `.superpowers/sdd/2026-11-21-audio-pairing-step2/netmirror-castle-rca.md`, `.superpowers/sdd/2026-11-21-audio-pairing-step2/offline-stuck-rca.md`

## Global Constraints

- Pairing never starts automatically. The donor is checked on tap only.
- Caps unchanged: `ADD_AUDIO_MAX_TRIES = 3`, `ADD_AUDIO_TRY_MS = 15000`, `ADD_AUDIO_TOTAL_MS = 30000`, same on web and APK.
- Copy byte-equal in `web/lib/player/loadingModel.js` `Copy` and `player/LoadingModel.kt` `Copy`; `…` is U+2026. This plan adds no client copy.
- Viewer languages: web `getPrefs().langs` (`web/lib/prefs.js:65`), APK `LanguagePrefs.langs()` (`data/Store.kt:59`). Empty list means `['te']` (Telugu). Telugu first, then the saved order.
- "In this stream" rows are never filtered. Only "Other servers" rows and Add entries follow the viewer's languages.
- Never drop an audio, video or language tag; never fall back to track 0 or another language (CLAUDE.md #1).
- Duration tolerance stays 15 s (`DURATION_TOLERANCE_SECONDS`, `utils/hybridStream.js:48`; `HybridPair.DURATION_TOLERANCE_S`).
- Offset agreement: `OFFSET_AGREE_SECONDS = 1`. Offset work budget: `OFFSET_BUDGET_MS = 8000` (inside the client's 15 s try). Offset measured only when `15 < delta <= PADDED_TOLERANCE_SECONDS` (900).
- Offset sign follows the nudge bar: positive = audio later (`utils/hybridStream.js:925`). A donor with 5 s extra at its start needs `contentOffset = -5`.
- Server log prefix: every `/hybrid/pair` decision logs exactly one line starting `[pair-gate] branch=<name>` with `video=<provider> audio=<provider>`.
- mp4 409 reason, exact: `the video is a single mp4 file; audio can only be added to HLS video`.
- Fire TV Silk is Chrome 70: no flex `gap`, no `:has()`, no `min()` in new CSS.
- Do not disable `masterMatchesTitle` (`providers/netmirror.js:613`).
- No commit steps. The owner commits on request. Each task ends by running its suite.
- Suites: server `node --test test/*.test.js` (baseline 490 pass, 0 fail, measured 2026-11-21); web `cd web && npx vitest run` (ledger 1097); APK `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew --no-daemon testReleaseUnitTest` from `android/` (ledger 338/0/5).

## Review Focus

- Viewer changes "Your languages" while the player is open: the next menu open uses the new list (web listens to `PREFS_EVENT`, APK reads `langs()` at menu build). (Tasks 7, 8.)
- Playing stream already carries every viewer language: no Add entry at all, and "Other servers" shows only viewer-language rows. (Tasks 7, 8.)
- Picture HLS has no audio of its own (video-only variant): the offset cannot be measured; a delta within 15 s still pairs, a padded pair keeps today's padded behavior, anything else refuses with a "could not measure" reason, never a guess. (Task 6.)
- Negative `contentOffset` (donor has extra at its start): the fused master's audio must start at picture time 0 with donor time 5 s, through `/pts-rebase`. Whether `withPts` accepts a negative value is unverified; Task 6 pins it. (Task 6.)
- mp4 with `moov` at the end of the file: the APK reads the tail range; a server that ignores Range or gives no `Content-Range` total makes the length unknown and the device gate refuses. (Task 9.)

---

### Task 1: Stream-down recovery (from offline-stuck-rca.md)

Source: `.superpowers/sdd/2026-11-21-audio-pairing-step2/offline-stuck-rca.md`. Most user-visible bug: spinner and "Trying another source…" forever after a re-resolved stream dies (W2), and an outage marking every source dead (W1).

**Files:**
- Modify: `web/lib/player/useRecovery.js:32` (signature), `:49-67` (`[stream]` effect)
- Modify: `web/components/Player.jsx:574-579` (online effect), `:618` (`useRecovery` call), failSwitch and `onFatal` failover call sites (`:448`, `:1571`)
- Create: `web/lib/player/offlineRecovery.js`
- Modify: `android/app/src/main/java/com/chitram/app/player/FailPolicy.kt`, `PlayerVm.kt:768`, `:813`, `:828-853` (`failover`), `:972-981` (`backOnline`)
- Test: `web/test/hooks/useRecovery.test.jsx` (extend), `web/test/offlineRecovery.test.js` (create), `android/app/src/test/java/com/chitram/app/FailPolicyOfflineTest.kt` (create)

**Interfaces:**
- Produces: `useRecovery({ videoRef, hlsRef, stream, onReResolve, online = true })`. A new `stream` resets `stalling.current = false` and `stallStage` to `null`. While `online` is false the ladder holds at `switching` without calling `onReResolve`; `online` turning true restarts the ladder.
- Produces: `offlineAction({ online, error, errorWhileOffline }) -> 'retryAll' | 'nudge' | null` in `web/lib/player/offlineRecovery.js`; `canFailOver(navigatorOnline: boolean) -> boolean`.
- Produces: `FailPolicy.onResolveMiss(offline: Boolean): ResolveMiss` with `enum class ResolveMiss { GO_OFFLINE, FAIL_OVER }`; `FailPolicy.backOnlineRetries(phase: String, failedWhileOffline: Boolean): Boolean` (true for `"failed"` reached while offline).

- [ ] **Step 1: Write failing web tests** in `useRecovery.test.jsx`:
  - `escalates again after a stream swap`: stall 26 s (stage `switching`, `onReResolve` 1 call), rerender with a new stream object, dispatch `waiting`, advance 26 s: `onReResolve` called 2 times; advance to 40 s after swap: stage `stuck`.
  - `holds the ladder offline`: `online:false`, stall 60 s: `onReResolve` 0 calls, stage `switching`; rerender `online:true`, advance 26 s: `onReResolve` 1 call.
  In `offlineRecovery.test.js`: `offlineAction({online:true, error:'x', errorWhileOffline:true}) === 'retryAll'`; `({online:true, error:null}) === 'nudge'`; `({online:true, error:'x', errorWhileOffline:false}) === null`; `({online:false}) === null`; `canFailOver(false) === false`.
- [ ] **Step 2: Write failing APK test** `FailPolicyOfflineTest`: `onResolveMiss(true) == GO_OFFLINE`, `onResolveMiss(false) == FAIL_OVER`, `backOnlineRetries("failed", true)`, `!backOnlineRetries("failed", false)`, `backOnlineRetries("playing", false)`.
- [ ] **Step 3: Run, verify fail**: `cd web && npx vitest run test/hooks/useRecovery.test.jsx test/offlineRecovery.test.js`; APK `./gradlew --no-daemon testReleaseUnitTest --tests 'com.chitram.app.FailPolicyOfflineTest'`. Expected: FAIL.
- [ ] **Step 4: Implement web.** Reset the latch in the `[stream]` effect. Pass `online` from `useNetworkStatus` (`Player.jsx:134`) into `useRecovery`. Gate `recoverBySwitching`, failSwitch and the `onFatal` failover on `canFailOver(navigator.onLine)` so an outage never marks a source dead. Record `errorWhileOffline` when `setError` runs with `online` false. The online effect calls `retryAll` when `offlineAction` says `retryAll` (this covers the error card, `:575-578`).
- [ ] **Step 5: Implement APK.** At `:768` and `:813`, when `fresh == null` and `onResolveMiss(isOffline()) == GO_OFFLINE`, call `goOffline()` and keep `pendingResolveMs = pos` instead of `failover(...)`. In `failover`, remember `failedWhileOffline = isOffline()` when it sets `Phase.Failed`. In `backOnline`, when `backOnlineRetries(phase, failedWhileOffline)` is true, re-resolve from the saved position instead of returning at `:977`.
- [ ] **Step 6: Run suites**: web `cd web && npx vitest run` (1097 + new, 0 fail); APK `testReleaseUnitTest` (338 + new, 0 fail, 5 skip).

---

### Task 2: Server: reproduce the 1511417 refusal

The padded rule should pass video 13506 s, audio 13434 s, TMDB 13440 s (delta 72, both within 600 s of runtime). Production returned no plan and blamed "different cuts" (`hybridRoutes.js:226-239` re-describes and assumes the runtime gate refused).

**Files:**
- Create: `test/fixtures/pair-1511417/` (`video-master.m3u8`, `video-media.m3u8`, `audio-master.m3u8`, `audio-media.m3u8`)
- Modify: `utils/hybridStream.js:494-555` (`planPairings`), `lib/media/hybridRoutes.js:168-239`
- Test: `test/hybridPair1511417.test.js` (create; `stubFetch`/`postPair` pattern from `test/hybridAudioPairing.test.js:30-58`)

**Interfaces:**
- Produces: `planPairings(streams, opts)` accepts `opts.onDescribe?: (stream, result: {desc: object|null, error: string|null}) => void`, called once per stream. The route keeps these first-pass results and builds the 409 from them; it re-describes only a side whose first pass threw.

- [ ] **Step 1: Capture fixtures.** Read-only, from the VM: fetch the vidrock `/m3u8-proxy` master and chosen media playlist and the castle-demux master and audio media playlist for movie 1511417 (re-mint the castle-demux id with `/api/streams` if it 404s). Save them unchanged. If capture fails, write stubs with the logged lengths (13506 s video, 13434 s audio, 1 audio rendition) and note "real shape not captured" in the test file header.
- [ ] **Step 2: Write failing tests**:
  - `pairs 1511417 on the padded rule`: POST the two urls with `tmdbId:1511417`, TMDB stub runtime 224 min (13440 s): 200; response `padded === true`, `deltaSeconds === 72`.
  - `a describe throw is reported as unreadable, not as a cut`: stub the audio master to throw once then succeed: 409 with `unreadable === 'the audio source'`, reason does not contain `different cuts`.
  - `different cuts only when the gate refused`: video 7330 s, audio 7008 s, runtime 0: 409 reason contains `different cuts: 322s apart`.
- [ ] **Step 3: Run, verify fail**: `node --test test/hybridPair1511417.test.js`. Record which assertion fails; that failure is the root cause. If test 1 passes on real fixtures, the cause is the throw path (test 2).
- [ ] **Step 4: Fix the root cause found in Step 3.** Route diagnostics use the `onDescribe` results. "different cuts" appears only when both sides described and the duration gate refused.
- [ ] **Step 5: Run suite**: `node --test test/*.test.js`. Expected: 490 + new pass, 0 fail.

---

### Task 3: Server: pair diagnostics and decision logs

**Files:**
- Modify: `utils/hybridStream.js:92-105` (`getText`), `:610-629` (`unwrapProxied`), `lib/media/hybridRoutes.js:204-239`
- Test: `test/hybridPairDiagnostics.test.js` (create)

**Interfaces:**
- Consumes: Task 2 `onDescribe` results.
- Produces: `getTextResult(url, headers) -> Promise<{text: string|null, status: number|null, contentType: string|null, error: string|null}>`; `getText` keeps its contract and calls it. `describeStream` failures carry `{status, contentType, error}` into `onDescribe`. `unwrapProxied` unwraps `/ts-proxy` the same as `/m3u8-proxy`. 409 body adds `video: {seconds, status, contentType}` and `audio: {...}`. Branch names: `unreadable-video`, `unreadable-audio`, `unreadable-both`, `mp4-video`, `no-audio-renditions`, `no-language`, `duration-match`, `padded`, `offset-measured`, `offset-disagree`, `offset-unmeasured`, `different-cut`, `ok`.

- [ ] **Step 1: Write failing tests**:
  - `unwrapProxied` of `http://x/ts-proxy?url=https%3A%2F%2Fcdn%2Fa.mp4&headers=%7B%22Referer%22%3A%22https%3A%2F%2Fr%2F%22%7D` gives `{url:'https://cdn/a.mp4', headers:{Referer:'https://r/'}}`.
  - Video upstream 403 `text/html`: 409 `video.status === 403`, `video.contentType === 'text/html'`, `missingHeaders === false` when the `/ts-proxy` wrapper carried a Referer.
  - Both sides unreadable: reason starts `neither source could be read back`.
  - Capture `console.log`/`console.warn`: exactly one line per request matches `/^\[pair-gate\] branch=(\S+) video=\S+ audio=\S+/`; branch is `unreadable-both`, `different-cut`, `padded`, `duration-match` in the matching tests.
- [ ] **Step 2: Run, verify fail**: `node --test test/hybridPairDiagnostics.test.js`.
- [ ] **Step 3: Implement** the interfaces above. Log the `[pair-gate]` line with `vs=<seconds|?> as=<seconds|?> vstatus= astatus= vtype= atype= delta=`.
- [ ] **Step 4: Run suite**: `node --test test/*.test.js`.

---

### Task 4: Server: mp4 video half gets its own 409

**Files:**
- Modify: `utils/hybridStream.js` (new `probeKind`), `lib/media/hybridRoutes.js` (before `planPairings`, `:172`)
- Test: `test/hybridPairMp4.test.js` (create)

**Interfaces:**
- Produces: `probeKind(url, headers) -> Promise<'mp4'|'hls'|'unknown'>`: one `Range: bytes=0-1023` fetch; `mp4` when content type starts `video/` (not `video/mp2t`) or bytes 4-8 are `ftyp`; `hls` when the body starts `#EXTM3U`. Route: video half `mp4` gives 409 `{error:'not pairable', reason:<exact mp4 reason>, progressive:true}` and branch `mp4-video`, without calling `planPairings` (it must not download the whole mp4 through `getText`).

- [ ] **Step 1: Write failing tests**: (a) video stub returns `video/mp4` with `ftypisom` bytes: 409, `reason === 'the video is a single mp4 file; audio can only be added to HLS video'`, `progressive === true`, the stub saw no non-range request; (b) same body served as `application/octet-stream`: same 409 (ftyp sniff); (c) `/ts-proxy` wrapped mp4 url: same 409; (d) HLS video: unchanged 200 path.
- [ ] **Step 2: Run, verify fail**: `node --test test/hybridPairMp4.test.js`.
- [ ] **Step 3: Implement** `probeKind` and the early refusal.
- [ ] **Step 4: Run suite**: `node --test test/*.test.js`.

---

### Task 5: Server: cut offset measurement module

**Files:**
- Create: `lib/media/cutOffset.js`
- Test: `test/cutOffset.test.js` (create)

**Interfaces:**
- Produces:
  - `envelope(pcm: Int16Array, sampleRate: number, frameMs = 10) -> Float32Array` (RMS per frame).
  - `bestLag(picture: Float32Array, donor: Float32Array, maxLagFrames: number) -> {lagFrames: number, score: number}`: normalised cross-correlation; positive lag = the picture's content appears later in the donor window.
  - `decodeWindow(url, headers, startSec, seconds, {signal}) -> Promise<Int16Array>`: spawn `ffmpeg -ss <start> -t <seconds> -headers <crlf> -i <url> -vn -ac 1 -ar 8000 -f s16le -`, killed on `signal`.
  - `measureOffset({videoUrl, videoHeaders, audioUrl, audioHeaders, videoSeconds, audioSeconds}, {decode = decodeWindow, budgetMs = 8000}) -> Promise<{ok:true, contentOffset:number, points:Array<{at,lag,score}>} | {ok:false, reason:'different cut'|'could not measure', points}>`.
- Constants: `WINDOW_SECONDS = 20`, `SAMPLE_RATE = 8000`, `OFFSET_AGREE_SECONDS = 1`, `MIN_SCORE = 0.5`, `OFFSET_BUDGET_MS = 8000`. Points on the picture: start `min(120, videoSeconds*0.1)`, middle `videoSeconds/2`, end `videoSeconds - 180`. Start search `±(delta + 10)` s; middle and end search `±(OFFSET_AGREE_SECONDS + 4)` s around the start lag. Decodes for one point run in parallel.

- [ ] **Step 1: Write failing tests** (fake `decode` from a seeded synthetic loudness track, no ffmpeg):
  - `bestLag` finds a 500-frame shift in a 2000-frame noise envelope; `score > 0.9`.
  - Donor = picture with 5 s extra at start: `ok === true`, `contentOffset === -5` within 0.1.
  - Donor 40 s shorter at the end only: `contentOffset === 0` within 0.1.
  - Extra 30 s at start and 42 s cut at end: `contentOffset === -30` within 0.1.
  - Donor with a 20 s insert at the middle: `ok === false`, `reason === 'different cut'`.
  - Unrelated donor (different noise): `reason === 'different cut'` (scores below `MIN_SCORE`).
  - `decode` that never resolves: result `reason === 'could not measure'` within `budgetMs` (fake timers), every decode signal aborted.
- [ ] **Step 2: Run, verify fail**: `node --test test/cutOffset.test.js`.
- [ ] **Step 3: Implement.** `contentOffset = -median(lags in seconds)` when all three lags are within `OFFSET_AGREE_SECONDS` of each other and every score is at least `MIN_SCORE`.
- [ ] **Step 4: Run suite**: `node --test test/*.test.js`.

---

### Task 6: Server: pair at the measured offset

**Files:**
- Modify: `utils/hybridStream.js:494-555` (`planPairings`), `:890-940` (`realisePlan`), `:965-975` (`planId`), `lib/media/hybridRoutes.js:168-245`
- Test: `test/hybridPairOffset.test.js` (create)

**Interfaces:**
- Consumes: Task 5 `measureOffset`; Task 3 branch names.
- Produces: `planPairings(streams, {..., keepRejected: true})` also returns pairs refused only by length (`15 < delta <= 900`) with `needsOffset: true`, ranked after accepted plans. Route on `needsOffset` (and on padded plans) calls `measureOffset` once per tap; `ok` sets `plan.contentOffset` and logs `offset-measured`; `different cut` gives 409 `reason: 'the two sources are different cuts: their audio does not line up at the start, middle and end'` and branch `offset-disagree`; `could not measure` keeps a padded plan as today (branch `padded`) and otherwise gives 409 branch `offset-unmeasured`. `realisePlan`: `ptsOffset = auto + contentOffset + nudge`. Measured offsets are cached by `video.url|audio.url` for `DESCRIBE_TTL_MS` (10 min). A plan with `delta <= 15` never calls `measureOffset`.

- [ ] **Step 1: Write failing tests** (inject `measureOffset` through `fakeApp`):
  - delta 10 s: `measureOffset` never called, 200.
  - 1511417 shape (delta 72, padded), measure returns `-66`: 200, fused audio media url carries `pts=-66` (plus probed auto), log branch `offset-measured`.
  - delta 200 s, no runtime, measure ok `-200`: 200.
  - delta 200 s, measure `different cut`: 409 with the exact reason above.
  - delta 1000 s: 409 `different cuts`, `measureOffset` never called.
  - Same tap twice within 10 min: `measureOffset` called once.
  - `withPts(url, -5)` ends `pts=-5`, and `/pts-rebase` with `pts=-5` shifts a stub TS segment's audio PTS down by 450000 ticks (90 kHz). If negative shifts are not supported, this test fails and the task stops for an owner ruling.
- [ ] **Step 2: Run, verify fail**: `node --test test/hybridPairOffset.test.js`.
- [ ] **Step 3: Implement** the interfaces above. Total server time for one tap stays under 15 s: describe plus `OFFSET_BUDGET_MS`.
- [ ] **Step 4: Run suite**: `node --test test/*.test.js`.

---

### Task 7: Web: viewer languages filter entries and other-server rows; no entry on mp4

**Files:**
- Create: `web/lib/player/userLanguages.js`
- Modify: `web/lib/player/addAudio.js:37-56` (`addAudioOffers`), `web/components/player/addAudioJourney.js:26-33`, `web/components/PlayerControls.jsx:285-302` (`mergedAudio`, `addLanguages`)
- Test: `web/test/userLanguages.test.js` (create), `web/test/addAudio.test.js`, `web/test/components/addAudioEntries.test.jsx`, `web/test/components/PlayerControls.test.jsx`

**Interfaces:**
- Produces: `userAudioLanguages(prefs = getPrefs()) -> string[]` (display names from `PREF_LANGS`, Telugu first, then saved order; `[]` gives `['Telugu']`); `useUserAudioLanguages() -> string[]` (re-reads on `PREFS_EVENT`); `isUserLanguage(name, langs) -> boolean` (via `audioLanguageKey`; `'Audio'`, empty or unknown give false).
- Changes: `addAudioOffers(sources, playing, audioTracks, userLangs = ['Telugu'])` returns `[]` when `playing.progressive`, else only offers whose language is in `userLangs`. `addAudioLanguages({..., userLangs})`.

- [ ] **Step 1: Write failing tests**:
  - `userAudioLanguages({langs:[]})` equals `['Telugu']`; `({langs:['hi','te']})` equals `['Telugu','Hindi']`; `isUserLanguage('Audio', ['Telugu']) === false`; `isUserLanguage('tel', ['Telugu']) === true`.
  - `addAudioOffers`: playing Hindi, donors carry Telugu, Tamil, Kannada, `userLangs ['Telugu','Tamil']`: languages `['Telugu','Tamil']`; `userLangs ['Kannada']`: `['Kannada']`.
  - Playing row `progressive: true` with Telugu donors: `[]`.
  - `PlayerControls`: audio menu with other-server rows Telugu, Tamil and an unnamed row (`Audio`), prefs `['te']`: "Other servers" shows only Telugu; "In this stream" Hindi and Tamil tracks all stay.
  - Prefs change event while mounted: next menu open shows the new set.
- [ ] **Step 2: Run, verify fail**: `cd web && npx vitest run test/userLanguages.test.js test/addAudio.test.js test/components/addAudioEntries.test.jsx test/components/PlayerControls.test.jsx`.
- [ ] **Step 3: Implement** the interfaces above. Filter `mergedAudio` rows that are not in-stream (`kind` not `muxed`/`in-file`, not `currentAudio`) with `isUserLanguage`.
- [ ] **Step 4: Run suite**: `cd web && npx vitest run`.

---

### Task 8: APK: viewer languages filter entries and other-server rows

**Files:**
- Modify: `android/app/src/main/java/com/chitram/app/player/AddAudio.kt:136-144` (`offers`), `PlayerVm.kt:1424-1458` (`audioMenu`) and its caller
- Test: `android/app/src/test/java/com/chitram/app/AddAudioTest.kt`, `V128Test.kt`

**Interfaces:**
- Produces: `AddAudio.userLanguages(codes: List<String>): List<String>` (labels via `LanguagePrefs.label`, Telugu first, empty gives `listOf("Telugu")`); `AddAudio.offers(sources, current, carried, onDevicePath, user: List<String> = listOf("Telugu"))`; `audioMenu(..., user: List<String>)` drops `OTHER_SERVERS` rows whose language is not in `user` (by `Ranking.sameLanguage`) or has no known language. PlayerVm passes `AddAudio.userLanguages(g.prefs.langs())` at each menu build.

- [ ] **Step 1: Write failing tests**: same cases as Task 7 Step 1 for `userLanguages` and `offers` (expected lists identical to web); `V128Test`: rows Telugu, Tamil, unnamed under "Other servers", user `["Telugu"]`: only `lang:Telugu` in `OTHER_SERVERS`; `IN_STREAM` rows unchanged.
- [ ] **Step 2: Run, verify fail**: `./gradlew --no-daemon testReleaseUnitTest --tests 'com.chitram.app.AddAudioTest' --tests 'com.chitram.app.V128Test'`.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run suite**: `testReleaseUnitTest` (0 fail, 5 skip).

---

### Task 9: APK: mp4 picture pairs on the device

**Files:**
- Create: `android/app/src/main/java/com/chitram/app/player/Mp4Duration.kt`
- Modify: `HybridPair.kt:129-148` (`mediaSeconds`, `deviceGate`), `AddAudio.kt:42` (`deviceResolved`), `:110-128` (`donorsFrom`), `:166-215` (`run`), `PlayerVm.kt:578-585` (merge), `:715-728` (`deviceMergeOk`)
- Test: `android/app/src/test/java/com/chitram/app/Mp4DurationTest.kt` (create), `HybridPairFallbackTest.kt`, `AddAudioTest.kt`

**Interfaces:**
- Produces: `Mp4Duration.mvhdSeconds(bytes: ByteArray): Double?` (walks top-level boxes to `moov/mvhd`; version 0 reads u32 timescale at +12 and u32 duration at +16 of the full box body, version 1 reads u32 at +20 and u64 at +24); `suspend fun Mp4Duration.seconds(url: String, range: suspend (url: String, range: String) -> RangeBody?): Double?` with `data class RangeBody(val bytes: ByteArray, val total: Long?)`: head `bytes=0-65535`, then tail `bytes=<total-524288>-` when `moov` is not in the head.
- Changes: `HybridPair.mediaSeconds` uses `Mp4Duration.seconds` for a progressive url. `AddAudio.deviceResolved(picture, donor)` is true also when `picture.progressive`. Donors exclude `progressive` rows on every path. PlayerVm builds `HybridPair.merge(sourceFor(mp4 picture), sourceFor(HLS donor))`; `HybridPair.pick` still pins the picture's video and the donor's L track.

- [ ] **Step 1: Write failing tests**:
  - `mvhdSeconds` of a built `ftyp`+`moov(mvhd v0, timescale 1000, duration 8974000)` gives `8974.0`; v1 with timescale 90000 gives the same; bytes without `moov` give `null`.
  - `seconds` with `moov` only in the tail (head has `ftyp`+`mdat`, total 10 MB): requests head then `bytes=9961472-`, returns the length; no `total` and no `moov` in head: `null`.
  - `deviceGate`: mp4 8974 s vs HLS 8980 s: `null` (agree); vs 9010 s: refusal contains `durations differ by 36.0 s`.
  - `AddAudio.run` with a progressive picture and a working server stub: `tryOne` never called, `device` called, hit returned.
  - `donors`: a progressive row with Telugu is never a donor.
- [ ] **Step 2: Run, verify fail**: `./gradlew --no-daemon testReleaseUnitTest --tests 'com.chitram.app.Mp4DurationTest' --tests 'com.chitram.app.HybridPairFallbackTest' --tests 'com.chitram.app.AddAudioTest'`.
- [ ] **Step 3: Implement** the interfaces above. The range fetch uses the picture's own `StreamInterceptor.client` headers, like `deviceMergeOk`.
- [ ] **Step 4: Run suite**: `testReleaseUnitTest` (0 fail, 5 skip); then `./gradlew --no-daemon assembleRelease` succeeds.

---

### Task 10: Live check

Runs after the owner deploys server, web and APK. Record timestamps, request ids and exact text in `.superpowers/sdd/2026-11-21-audio-pairing-step3/live.md`.

- [ ] **Step 1: Server**: replay movie 1511417 (vidrock video + CastleTV audio): 200 or a 409 whose `[pair-gate]` branch names the real gate. `grep '\[pair-gate\]'` on the VM log shows one line per tap. Measure tap-to-answer time; it must be under 15 s on an `offset-measured` tap.
- [ ] **Step 2: mp4**: Animal (781732) NetMirror mp4 `POST /hybrid/pair`: 409 with the exact mp4 reason, under 2 s. Web on that row: no Add entry. APK on that row with prefs `te`: Add Telugu entry, tap pairs on device, Telugu plays in sync, log `[addaudio] device merge ... durations agree`.
- [ ] **Step 3: Languages**: prefs `te` only, a title with Hindi, Tamil, Telugu servers: one Add entry at most (Telugu), "Other servers" shows Telugu only, no "Audio" row; the server picker still lists every server.
- [ ] **Step 4: Stream-down**: web, kill the playing stream's segments (DevTools block pattern) after a re-resolve: ladder reaches the stuck buttons by 40 s. Web offline 60 s then online: no source marked dead, playback resumes or the error card retries by itself. APK airplane mode during a re-resolve: offline note, then playback on network return.
- [ ] **Step 5: Run all suites** once more and record counts.
