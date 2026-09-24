# Title matching — measured baseline (2026-09-21)

All numbers from the live API on localhost:8790, full provider fan-out.
Reproduce: `curl -s "localhost:8790/api/streams/movie/<tmdbId>"`

## The defect this replaced

`normalizeTitle` stripped to `[a-z0-9]` WITHOUT deaccenting first, so a macron
became a SPACE. Census of 15 real Indic titles: **11 normalised to garbage.**

    "Bāhubali: The Beginning" -> "b hubali the beginning"
    "Ārya"    -> "rya"        "Kāntārā" -> "k nt r"
    "Sītā Ramam" -> "s t ramam"

castletv then fell back to `rows[0]`, so we served a DIFFERENT film titled
"Beginning" and reported Bāhubali as Tamil-only. After the fix: **0 of 15
garbled.**

## The rule

Loosen the SEARCH (more candidate rows), keep the MATCH strict.
A wrong match plays a different film silently; a miss lets another provider win.

Search breadth measured over the top 20 Telugu titles by revenue:
**46 queries total, avg 2.3/title** — 7 for "Bāhubali", 1 for "RRR".
It expands only where diacritics/vowel drift need it.

## False negatives found by resolving live titles, and recovered

| Title (tmdbId) | Catalogue row | Streams before → after |
|---|---|---|
| Salaar: Part 1 - Ceasefire (770906) | `Salaar` | 1 → **13** |
| Ponniyin Selvan: Part I (660046) | `Ponniyin Selvan` | 1 → **7** |
| Pushpa 2 - The Rule (857598) | `Pushpa 2: The Rule (Reloaded Version)` | matched; 0 playable (preview-gated) |
| Kalki 2898-AD (801688) | `Kalki 2898 AD (Hindi)` | matched; 0 playable (preview-gated) |

Each was fixed by a MORE PRECISE rule (part numbers, language/edition tags),
never by loosening. A new guard (`conflictingParts`) was added at the same time.

## Guards that must never regress

- `Ponniyin Selvan: Part Two` must NOT answer a request for `Part I`.
  Both rows came back in ONE Castle result set (660046).
- `Pushpa: The Rise - Part 1` must NOT answer `Pushpa 2 - The Rule`.
- `Beginning` must NOT answer `Bāhubali: The Beginning`.
- `Kantara A Legend` must NOT answer `Kantara Chapter 1`.
- No `|| rows[0]` anywhere.

## Zero results that are CORRECT, not bugs

Distinguish in the log: `No confident match` = matcher skipped it;
`Got 0 stream(s)` = matched fine, nothing playable behind it.

- **RRR (579974), Bāhubali 2 (350312), Kalki (801688)** — matched, but Castle
  serves only `index_preview_*.m3u8` / `isPreview:true`. Premium-gated.
- **256040 via NetMirror** — found hotstar's master, rejected as the known
  placeholder (`serves video from 220884`).
- **Prime decoys** — `Baahubali The Lost Legends`, `Bheemadevarapally Branchi`.
  Genuinely different films; refusing them is the point.

### Final top-20 run (after all three rules landed)

**0 matcher rejections across all 20 titles.** Every title either matches or
the catalogue genuinely has nothing behind it. Matching is no longer a limiting
factor anywhere in this set.

    Bahubali 2          1  sel=0  tel=-      Pushpa: The Rise      9  sel=0  tel=Y
    Pushpa 2 The Rule   1  sel=0  tel=-      Oosaravelli           2  sel=0  tel=-
    A Aa                3  sel=1  tel=Y      Peddi                 1  sel=0  tel=-
    RRR                 1  sel=0  tel=-      Ala Vaikunthapurra..  6  sel=0  tel=Y
    Kalki 2898-AD       1  sel=0  tel=-      Bharat Ane Nenu       1  sel=0  tel=-
    Bahubali 1          4  sel=1  tel=Y      Mana ShankaraVara..   4  sel=1  tel=Y
    Salaar Part 1      13  sel=0  tel=Y      Maharshi              0  sel=0  tel=-
    Saaho               1  sel=0  tel=-      Sarkaru Vaari Paata   1  sel=0  tel=-
    Devara: Part 1      6  sel=1  tel=Y      Radhe Shyam           5  sel=0  tel=-
    Sarileru Neekevvaru 0  sel=0  tel=-      Game Changer         11  sel=0  tel=Y

    8/20 carry Telugu; 5 expose a selectable audio menu.

Remaining zero/thin results are catalogue gaps, not matching:
Maharshi (541487) returned 0 from BOTH castletv and vaplayer (tt8333978).

## Test baselines

    npm test               68 passed, 0 failed
    cd web && npx vitest   535 passed, 0 failed (51 files)

## Still unverified

- **dahmermovies** — `a.111477.xyz` is FortiGuard-blocked on this network; the
  403 is a web-filter page, not the origin. Accented path is tried FIRST, so
  the change can only add a candidate.

## Hybrid stream baselines — 2026-09-22

Test suites after adding `test/hybridStream.test.js` (9 tests) and 3 hybrid
cases in `web/test/tvProfile.test.js`:

```
npm test                        → 84 passed, 0 failed   (was 75)
cd web && npx vitest run        → 53 files, 556 passed, 0 failed  (was 553)
```

### Segment-boundary drift, Devara (tmdb 811941)

The reason `HLS_CONFIG_HYBRID` exists. Same cut, different chunking:

```
showsst  2060 segments  10299.58 s = 171.66 min   (1920x804 variant)
castle   3378 segments  10299.63 s = 171.66 min   (720p Telugu)
cumulative drift 0.05 s  → sails through the 15s duration gate
```

But the fragment boundaries are ragged, which is what breaks SEEK:

```
video EXTINF: 5, 5, 5, 5, 5              (uniform)
audio EXTINF: 3.75, 4.083, 6.125, 1, 3.75  (ragged)
audio segments under 2s: 1312 of 3378  (39%)
boundary gap @1800s -0.96s | @3600s -1.25s | @5400s -1.96s | @9000s -0.08s
```

Worst measured straddle 1.96s vs hls.js default `maxBufferHole: 0.5` and
`maxFragLookUpTolerance: 0.25`. Both raised to 2.5.

### Live end-to-end, 2026-09-22 (`/api/streams/movie/811941`)

```
8 streams, hybrid ranked index 0:
  showsst+CastleTV  1080p  hybrid=Y  http://localhost:8790/hybrid/<id>/master.m3u8
master: 4 audio renditions + 3 video variants, Telugu DEFAULT=YES
video codec probed from SPS NAL: avc1.640028
variant playlist through m3u8-proxy: http=200, 2060 EXTINF
video seg @1080: http=200  1,095,288 bytes  4.36 s   (slow CDN, not our path)
audio telugu playlist: http=200, 3378 EXTINF
audio segs 1/1500/2500/3300: all http=200, 0.28-0.62 s
```

No double-wrapped `ts-proxy?url=...ts-proxy?url=...` in any child URL.

## Audio/video sync — root cause and fix, 2026-09-22

Reported as "not syncing the audio to video properly". Distinct from the seek
stall: a CONSTANT offset, not drift, which is why the 15s duration gate (0.05s
apart) passed while sync was still wrong.

### Root cause

The two providers disagree on where zero is.

```
showsst  video seg 0   start_pts 0.000000
castle   audio seg 0   start_pts 1.478556
```

Castle's OWN muxed stream starts at video 1.525000 / audio 1.478556 — 47ms
apart, internally consistent and imperceptible. Our `-copyts` demux preserves
that faithfully. The bug was binding it to a video source that starts at 0.
hls.js aligns by PTS, so the audio ran ~1.48s late for the whole film.

Constant, not cumulative — playlist position minus real PTS:

```
seg 1     0.000     1.478556   Δ 1.4786
seg 500   1497.625  1499.026   Δ 1.4013
seg 1500  4532.708  4534.130   Δ 1.4221
seg 2500  7504.042  7505.448   Δ 1.4061
seg 3370  10207.000 10208.413  Δ 1.4133
```

One measurement at the head therefore corrects the entire timeline.

### Fix

`extractTrack(buf, streamIndex, ptsOffsetSeconds = 0)` adds ffmpeg
`-output_ts_offset` on top of `-copyts`. Threaded as `?pts=` on the rendition
playlist url and stamped onto each segment url. Measured per pairing by
`probeStartPts`, never hardcoded — 1.478556 is this title's value, not the
provider's. Both probes failing falls back to 0 (no shift beats a wrong shift).
Video is never rebased. Sub-50ms offsets are ignored (one frame at 24fps=41ms).

### Verified after fix

```
vpts=0 apts=1.478556 ptsOffset=-1.478556
audio-3.m3u8?pts=-1.478556  →  seg 0 rebased_pts 0.000000

target   v_decl    v_pts    a_decl     a_pts   PTS err
     0     0.00    0.000      0.00     0.000    0.000s
  1500  1500.00 1500.000   1501.42  1501.356   -0.061s
  4500  4500.00 4500.000   4499.33  4499.261   -0.072s
  9000  9000.00 9000.000   9000.08  9000.008   -0.075s
 10200 10200.00 10200.000 10196.58 10196.509   -0.074s
```

Residual ~0.07s across 170 min, down from 1.48s; under the ~0.125s lip-sync
perception threshold.

Standalone Castle regression check — no `?pts`, seg 0 still `1.478556`. Unchanged.

Suites: backend 86 passed (was 84), web 556 passed. 0 failures.

## Automated source ranking — 2026-09-22

"Defaults must work, automated reliable fallbacks." The viewer picks nothing.

### Coverage census, 16 Telugu titles

```
hybrid offered       7 / 16
castle multi-track   8 / 16
has telugu at all    9 / 16
telugu at 1080p+     5 / 16
telugu ONLY below HD 4 / 16   (Salaar, RRR, Saaho, Maharshi)
```

Every title has 1080p video; only 9 have Telugu. The scarce resource is
LANGUAGE, not pixels — so the ranking spends resolution to buy language.

### rankSources tiers (web/lib/backend.js)

```
0  hybrid                        best video + preferred language, in sync
1  preferred lang + switchable   multi-track master, position-preserving switch
2  preferred lang, any res       720p Telugu beats 1080p Hindi
3  switchable, no preferred      viewer can at least choose
4  anything, best resolution     play rather than refuse
```

Resolution breaks ties WITHIN a tier only, never across one.

### Verified live, one request each (clean server)

```
Devara     -> showsst+CastleTV  1080p  telugu=YES switchable=Y   tier 0
Salaar     -> CastleTV           720p  telugu=YES switchable=-   tier 2
RRR        -> CastleTV           720p  telugu=YES switchable=-   tier 2
Novocaine  -> showsst           1080p  telugu=no                 tier 4
Kalki      -> CastleTV          1080p  telugu=no                 tier 4
```

Suites: backend 86 passed, web 564 passed (was 556). 0 failures.

### CORRECTION to an earlier claim in this file

RRR's Telugu is NOT dropped as "OST". Measured live: `langs=[Telugu]` at 720p
and 480p. Scanned 899112/770906/615656/369972 — no OST leaks into any label.
The OST tag appears only in VIP metadata, not on the playable path. The earlier
"REAL BUG FOUND" note was wrong; no fix was needed.

### OPEN BUG — connection pool leak

Running the 16-title census concurrently wedged the server at
`[pool] active=94 queued=13 free=0` and it never drained. CastleTV then
silently returned 0 streams on every title, so Devara ranked showsst 1080p
(no Telugu) — looked like a ranking bug, was actually pool exhaustion.
Only a restart cleared it. Sequential requests are fine. Not yet investigated.

## Separated audio / video / syncer — 2026-09-22

The sync fix originally lived inside the castle-demux route, so ONLY Castle
audio could be rebased. But `describeStream()` classifies an audio source by
MEASURED renditions, not by provider name — so NetMirror, or anything else
shipping EXT-X-MEDIA renditions, would be paired and then desync silently,
because its segments go through m3u8-proxy where no rebase existed.

### The three parts, now separate

```
VIDEO   any stream with a variant ladder        (hybridStream.describeStream)
AUDIO   any stream with EXT-X-MEDIA renditions  (hybridStream.describeStream)
SYNCER  utils/ptsRebase.js — provider-agnostic
```

`utils/ptsRebase.js` holds the primitives: `startPts`, `offsetFor`,
`rebaseSegment`, `withPts`, `ptsFromQuery`. It takes raw MPEG-TS bytes and an
offset; it does not know which provider produced them. `hybridStream` now uses
it instead of reaching into `castleDemux` (that coupling is gone).

### Two segment paths, because only one can shift its own timestamps

```
LOCAL  castle-demux   already runs ffmpeg per segment to split tracks,
                      so `?pts=` rides along free
REMOTE anything else  served untouched by m3u8-proxy -> routed through the new
                      GET /pts-rebase, marked `rebase=1` in the master
```

Deliberately NOT folded into ts-proxy: that handler streams with range requests
and tail prefetch, while a shift needs the whole segment in hand.

### Verified live

Remote (showsst, non-Castle) segment through the new generic route:

```
via ts-proxy   (baseline)  start_time 0.000000
via pts-rebase &pts=7.5    start_time 7.500000   233,308 bytes
```

Zero-offset passthrough is byte-identical — no corruption on the normal path:

```
ts-proxy   md5 aaf129017e52f2ea37aa25f1ba2e1b20  219960 bytes
pts-rebase md5 aaf129017e52f2ea37aa25f1ba2e1b20  219960 bytes
```

Castle unchanged: hybrid seg0 `0.000000`, standalone seg0 `1.478556`.

Suites: backend 95 passed (was 86), web 564 passed. 0 failures.

## Two dropdowns, hybrid auto-pick removed — 2026-09-22

The player used to inject ONE fused row per combination ("showsst+CastleTV")
above the plain streams, so choosing a picture and choosing a language were the
same act, and every extra language multiplied the source list (V x A rows).

Now: two independent menus, V + A rows.

```
VideoMenu   whose picture   components/player/VideoMenu.jsx   badge = resolution
AudioMenu   which language  components/player/AudioMenu.jsx   badge = language
```

### What changed

- `apiServer.js` — hybrid auto-injection now requires `enableHybridStreams:true`
  (was `!== false`). Machinery kept; only the automatic fused row is gone.
- `web/lib/player/trackChoices.js` — NEW. `videoChoices`, `audioChoices`,
  `pairingFor`. 14 tests.
- `components/player/VideoMenu.jsx` — NEW, mirrors AudioMenu.
- `POST /hybrid/pair` — NEW. Pairs a viewer-chosen pair on demand, applying the
  duration gate (409 when the two halves disagree on runtime).
- `web/lib/backend.js` — `pairSources()`.
- `Player.jsx` — `pickPair` handles the three outcomes below.

### The three outcomes of a pair (trackChoices.pairingFor)

```
in-file     language lives inside the chosen picture -> rendition switch
pair        halves live in different providers       -> POST /hybrid/pair
substitute  language only exists welded into its own file -> source switch,
            with a note ("Telugu is only available at 720p")
```

`substitute` is the Salaar case and is a real property of the catalogue: Castle
ships each language as its own muxed 720p file, so there is no track to lift.

### Verified live (Devara 811941)

```
GET /api/streams/movie/811941   7 streams, hybrids: 0   <- fused row gone
POST /hybrid/pair {showsst 1080p, CastleTV 720p}
  -> {"url":".../hybrid/d14d91a8807099d73a40119c/master.m3u8","delta":0.042}
master: 4 audio renditions, Telugu DEFAULT=YES, all ?pts=-1.478556
        1 video variant 1920x804 avc1.640028
```

Suites: backend 95 passed, web 578 passed (was 564). 0 failures.

## Servers control + audio-switch crash — 2026-09-22 (browser verified)

Verified in Chromium on localhost:3200, Devara (811941), playing.

### BUG FIXED: picking a language threw inside hls.js

`useHls.pickAudio` assigned the menu id straight to `hls.audioTrack` with no
bounds check. The Audio menu also lists languages living in OTHER sources,
whose ids are not hls track indices, so:

```
TypeError: Cannot read properties of undefined (reading 'details')
  at AudioTrackController.setAudioTrack (hls.mjs:20359)
  at set audioTrack (hls.mjs:40906)
  at lib/player/useHls.js:281   <- pickAudio
```

The label flipped to Hindi and the audio never changed (currentTime frozen at
568.89). `pickAudio` now bounds-checks and returns false; PlayerControls falls
through to the source-switch / pairing paths on a refusal.

After (same click, same title):

```
before {"t":626.45,"paused":false}
after  {"t":634.87,"paused":false,"w":1718,"h":720,"err":null}
label  "Audio language: Hindi. 5 available"
console  0 occurrences of setAudioTrack / reading 'details'
```

### Video menu -> "Servers" (provider + max quality)

Resolution alone duplicated the separate Auto/ladder quality control and hid
what actually differs between rows. Live:

```
Servers
[ ] showsst   up to 1080p
[ ] VaPlayer  up to 1080p
[x] CastleTV  up to 720p · Kannada, Malayalam, Tamil +1
[ ] CastleTV  up to 720p · Telugu, Tamil, Malayalam +1
[ ] CastleTV  up to 720p · Hindi
[ ] CastleTV  up to 480p · Telugu, Tamil, Malayalam +1
[ ] CastleTV  up to 480p · Hindi
```

`sourceMeta` is exported from PlayerControls and passed in as `describe`; its
trailing rung is stripped, since leading with "up to <q>" already says it
(it rendered "up to 1080p · 1080p" before the strip).

### Providers removed from Settings

The sheet is now subtitles only — the provider list had become two places
showing one thing.

```
Settings -> groups ["Subtitles"], rows Off / English (WEB-DL) / English (720p)
```

### Tests

5 tests asserted the Source group lived in the sheet; retargeted to the
Servers menu (fixtures need `masterUrl`, and a LONE server renders a static
badge with no menu, so those fixtures need a second row).

```
npm test                 95 passed, 0 failed
cd web && npx vitest run 578 passed, 54 files, 0 failed
```

## Three bugs on movie/1408162 — 2026-09-22 (browser verified)

### 1. showsst would not play (duration 0:00, spinner, 403s)

`rewriteM3u8` decided "playlist vs segment" by matching `.m3u8` in the URL.
showsst serves BOTH its variants and its segments as `https://host/api?d=<blob>`
— nothing in the URL distinguishes them — so a VARIANT PLAYLIST was routed to
ts-proxy. hls.js got playlist text where it expected MPEG-TS (duration 0:00,
permanent spinner), and the segments inside were never rewritten, so the browser
fetched them from the origin and got 403.

Fix: a URL line FOLLOWING `#EXT-X-STREAM-INF` is a variant, whatever it is
named. The flag clears after its own URL line, or every later segment in a
media playlist would be treated as a playlist too.

```
before: master -> 3x ts-proxy          child = playlist text, 0:00
after:  master -> 3x m3u8-proxy        child -> 1923x ts-proxy
        segment: HTTP 200 174840B ct=video/mp2t   h264 640x268 + aac
browser: dur 9621.4s, plays, ABR climbed 640x268 -> 1280x534
```

### 2. Language pinning did nothing (POST /hybrid/pair -> 404)

`web/next.config.mjs` proxies /api, /castle-demux, /m3u8-proxy and /ts-proxy to
8790 but NOT /hybrid or /pts-rebase, so the browser posted to NEXT and got 404.
Picking a language from another provider silently fell back to the one playing.
Added both rewrites. `POST /hybrid/pair` through 3200: 404 -> 409 (route
reached), and a real pairing returns

```
{"url":".../hybrid/ebbd989dae64439bdc5b6c53/master.m3u8","delta":0.2376,"nudge":0}
master via 3200: HTTP 200, 5 audio renditions, 3 video variants
  Hindi NO / Kannada NO / Malayalam NO / Tamil NO / Telugu DEFAULT=YES
```

### 3. Connection pool leak — FIXED (was open since yesterday)

`fetchWithTimeout` cleared its abort timer once HEADERS arrived, so a response
whose BODY stalled was never aborted and its socket never returned to the
agent. `pipeUpstream` only cleaned up on error or client-close, not on a body
that simply went quiet. With maxSockets=64 the pool wedged and stayed wedged:

```
[pool] active=65 queued=14 free=0      <- never drained
showsst master: HTTP 500 "The user aborted a request." 30.0s  (x3)
```

Two fixes in `proxy/proxyServer.js`:
- `pipeUpstream` now has a stall watchdog RESET BY PROGRESS (`BODY_STALL_MS`,
  default 25s). A big segment may take as long as it likes provided it keeps
  sending; going silent reclaims the socket.
- `readBodyWithTimeout()` bounds every buffered `arrayBuffer()`/`text()` read
  (4 call sites), which previously had no deadline at all.

```
after restart: [pool] active=1 queued=0 free=3
showsst master: HTTP 200 3398B 0.47s   (was 500 @ 30s)
```

NOTE: a `castle-demux/<id>` URL is a job in an IN-MEMORY map. A server restart
404s every previously-resolved demux URL, so a saved streams fixture must be
re-resolved after restarting or describeStream reads null and pairing refuses.
That cost a false "pairing is broken" diagnosis.

### Tests
```
npm test                 100 passed, 0 failed   (was 95; +5 m3u8Rewrite)
cd web && npx vitest run 588 passed, 55 files   (was 578; +10 syncBar)
```

## "Changing server moves audio to Hindi/Default" — 2026-09-22 (browser verified)

Reported on movie/1408162. THREE separate defects, each of which alone loses
the language. All measured, none found by reading code.

### A. The badge invented a language it was not playing

`AudioMenu` did `audioTracks.find(...) || audioTracks[0]`. That list MIXES the
language playing now with languages that merely COULD be paired in from another
provider, so element 0 is often not this stream's audio. showsst and VaPlayer
ship `languages: []` and no renditions, so nothing matched and the button
displayed CastleTV's first language:

```
showsst playing -> button read "Audio language: Hindi. 5 available"
```

Nothing had switched to Hindi; only the LABEL was wrong. Fallback removed; the
badge now reads "Default" when nothing is known to be selected.

### B. The viewer's language was dropped on a source switch

The Servers menu calls `onPickSource(source)` -> `switchSource`, which carries
only the picture. The new file then fell back to `initialAudioTrack`'s
build-time PREFERRED_LANGUAGE and then to the manifest DEFAULT flag - Hindi on
these titles. `useHls` now takes `preferredLanguage` (a ref, so it is readable
inside the hls.js handlers without re-running the attach effect and rebuilding
the player) plus an `onLanguage` callback, and Player holds `wantLang`.

FIRST ATTEMPT WAS WRONG and the browser caught it: `wantLang` was only set from
an explicit `pickAudio`, but `initialAudioTrack` auto-selects Telugu on attach
and never goes through it. Instrumented and measured at the moment of the
switch:

```
[langkeep] want=null srcId=showsst-3 curId=CastleTV-0 srcLangs=[]
```

So the standing language now also falls back to what is actually PLAYING
(`hls.audioTracks[hls.currentAudio].name`), not only to an explicit pick.

### C. A source with no renditions was chosen as the audio donor

When the new server cannot supply the language in-file, switchSource now
re-pairs it with a source that can. The first donor match was wrong: three
CastleTV rows all LIST Telugu but only the castle-demux row has
`selectableAudio`, and the backend refuses the others:

```
POST /hybrid/pair -> 409 {"error":"not pairable",
  "reason":"the two sources disagree on runtime, or neither carries audio..."}
```

Server-side the same pair with the DEMUX row returns 200, which is what proved
the 409 was our choice of donor and not a real runtime mismatch:

```
showsst  secs=9621.444    CastleTV secs=9621.207    delta 0.2376  (tolerance 15)
```

Donor selection now prefers `selectableAudio`, falling back to any row that
lists the language.

### Verified end to end (Telugu standing, CastleTV -> showsst)
```
POST /hybrid/pair -> 200  delta 0.2376849999473052
Server: showsst. 5 available | Audio language: Telugu. 5 available
t 2574.8 -> 2599.8  advanced 25.0s  paused false  err null
buffered [2558.5, 2692.1]   dur 9621.2   1722x720
```
Before the fix the same steps gave "Audio language: Default" and no pair call.

### Not our bugs (do not re-debug)
- `/api/vm/*` 401: that path relays to a SEPARATE VM resolver
  (187.127.137.85:7801) signed with HMAC. `RESOLVER_SHARED_SECRET` is unset, so
  `signedHeaders()` returns {} and the VM rejects it. Direct curl to the
  resolver also 401s. Unrelated to playback, which uses 8790.
- VaPlayer `m3u8-proxy -> 522`: Cloudflare cannot reach THEIR origin. It now
  fails fast instead of wedging the pool (stall watchdog working).

### Tests
```
npm test                 100 passed, 0 failed
cd web && npx vitest run 592 passed, 56 files   (+4 audioBadge.test.jsx)
```

## ts-proxy 500 "The user aborted a request" — 2026-09-22 (measured)

A healthy segment 500d after 42s while the SAME url fetched directly returned
200 in 0.43s, so the fault was entirely ours:

```
via ts-proxy:  500  42.006s  {"error":"The user aborted a request."}
direct:        200   0.428s  216952 B, first byte 0x47 (valid MPEG-TS)
[pool] active=128 queued=87 free=0
```

ROOT CAUSE - abandoned requests kept their socket.

`res.on('close')` only LOGGED the disconnect; nothing aborted the upstream
fetch. hls.js cancels segments on every seek and every quality switch, so each
abandoned request held a pool slot for the full BODY_TIMEOUT_MS (30s). The
telltale is in the log: 27 of 41 aborts recorded `bytes=0` - they never
received a single byte because they never got a socket.

Compounding it, `fetchWithTimeout` spread `options` BEFORE `signal`, so a
caller-supplied signal was silently overwritten and could never have worked.

Three fixes in `proxy/proxyServer.js`:
- `fetchWithTimeout` now honours an external `options.signal` (linked to its
  own controller, listener removed in `finally` so it does not leak a closure
  per request).
- `/ts-proxy`, `/m3u8-proxy` and `/sub-proxy` each own an AbortController that
  fires on client disconnect; all 8 upstream fetches pass its signal.
- `maxSockets` 64 -> 256 (`PROXY_MAX_SOCKETS`). One playback opens several
  segments at once and a hybrid pair fans out to BOTH providers, so 64 was
  reachable in normal use.

VERIFIED - the reported url, and a load test cancelling half the requests
mid-flight the way hls.js does:

```
same url after fix:  200  0.721s  216952 B  ct=video/mp2t
                     ffprobe: h264 1280x534 + aac

20 concurrent (10 killed at 0.3s): all 200, 1.15-2.29s
[pool] active=20 queued=0 free=0   ->   active=1 queued=0 free=19
CLIENT ABORTED x10 all reclaimed;  "user aborted" errors since restart: 0
fresh request after the storm: 200 in 0.557s
```

NOTE `timeout: 60000` on the agents is socket-IDLE only. It does not bound a
request whose body stalls, nor one queued for a socket - that is why both the
pipeUpstream watchdog and this abort wiring are needed.

### Tests
```
npm test                 100 passed, 0 failed
cd web && npx vitest run 592 passed, 56 files
```

## 2026-09-22 — "i am unable to switch to vaplayer"

VaPlayer's origin is dead (Cloudflare 522, their own homepage too). The bug on
our side was that a dead provider looked identical to a slow one: no message,
frozen frame, zero network activity. Three defects, all measured in the browser
on `/title/movie/1408162`.

**1. A refused pair cancelled the NEXT switch's backstop.**
`pickPair`'s 409 path ran a bare `clearTimeout(switchTimer.current)` AFTER its
`await pairSources(...)`. The pair request takes the full 12s, by which time
`switchSource` had already fallen through and armed the VaPlayer timer — so the
clear killed a timer it did not start. `beginSwitch` now returns its handle and
`endSwitch(id)` only clears when it is still the live one. Same fix applied to
`commitAudioSync`.

Measured trace (ids and ms-mod-100000):
```
[bs] begin Pairing CastleTV audio… clears null at 17954   -> id 206
[bs] done() clears 206
[bs] endSwitch id= 206 cur= 206 at 29961                  <- 12s later
[bs] begin Switching to VaPlayer… clears null at 29961
```

**2. The stall test used the wrong signal.**
`!videoWidth` never fires — the element keeps the previous source's dimensions
after a failed attach (t frozen while videoWidth read 1722). A position snapshot
taken at click time is also wrong: the OLD source keeps playing while the new
master is fetched, measured t 2879.2 -> 2891.8, a 12.6s advance on a stream that
was being replaced. Now: sample `currentTime` when the backstop fires, sample
again 1.2s later, and report only if paused and unmoved.

**3. A teardown resize was read as a landed switch.**
The clear-effect treated every `resize` as success, but detaching a source
resizes the element to 0x0. Guarded with `if (v.videoWidth > 0)`.

**Verified in the browser** — the text actually rendered:
```
msg: "VaPlayer is not responding. Try another server."
srv: "Server: VaPlayer. 5 available"   p: true   w: 0
```
Timing note for re-testing: the pair attempt eats 12s BEFORE the VaPlayer
backstop is armed, so the message appears ~24s after the click, not ~12s. An
earlier read showed `msg: null` purely because the test sampled too early.

**Suites after these edits:**
```
npm test (backend)         100 passed, 0 failed
cd web && npx vitest run   592 passed, 56 files, 0 failed
```

## 2026-09-22 — NetMirror: measured dead upstream, NOT a code bug

Asked to work on netmirror. Measured first; there is nothing to fix in our code.

**Symptom:** netmirror is enabled and loads, but returns 0 streams on every
title tried — 1440735, 1408162, 693134 (Dune: Part Two), 155 (The Dark Knight).

**1. Search and matching work.** The title is found on primevideo and hotstar
and a master is returned. `pickSearchMatches` is not the problem.

**2. Every master points its VIDEO rungs at one shared file id, 220884.**
The audio renditions carry the CORRECT per-title id and real languages, so the
placeholder guard `masterMatchesTitle()` is right to reject: playing it gives
the wrong film's picture. Sample (The Dark Knight, pv path):
```
#EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="tel",NAME="[4] Telugu",
  URI="https://s14.freecdn2.top/files/0QSTXR0EXWWYI4D3UGMLFM4A0Q/a/3/3.m3u8"
#EXT-X-STREAM-INF:...RESOLUTION=1920x800
https://s21.freecdn4.top/files/220884/1080p/1080p.m3u8?in=unknown::ni
```

**3. The CDN serves nothing at all.** Not a decoy we can route around:
```
220884/720p/720p.m3u8                    -> 404
<per-title id>/720p/720p.m3u8            -> 404   (video path does not exist)
<per-title id>/a/3/3.m3u8  (Telugu)      -> 404
<hotstar id>/a/2/2.m3u8    (Telugu)      -> 404
```
So netmirror is not usable even as a Telugu AUDIO donor for pairing.

**4. Separately, the Netflix path is SNI-blocked by the local ISP.**
Not our code and not the reason for the 0 streams. Same IP, same port 443:
```
system DNS  net27.cc -> 49.205.171.201   (ISP block page: HTTP 403, TLS reset)
1.1.1.1     net27.cc -> 123.176.40.67    (real host)
--resolve net27.cc:443:123.176.40.67     -> TLS SSL_ERROR_SYSCALL
--resolve example.com:443:123.176.40.67  -> 200      <- same IP, innocuous SNI
Host: net27.cc over plain HTTP           -> 404 (passes, just not served)
```
Discovery domains are fine: `mobiledetects.com/checknewtv.php` -> 200.

**Conclusion:** leave netmirror enabled and rejecting. Re-test upstream later;
do not spend time on our matching or extraction code for this.

## 2026-09-22 — mapple: domain moved uk -> fun, API reachable without a browser

**The domain moved.** This is what the provider-repair cron
(`web/app/api/cron/provider-repair/route.js`, kind `mapple-api`, Supabase column
`ott_provider_config.base_url`) exists to catch, and it has not caught it:
```
https://mapple.uk/      -> 301 -> https://mapple.fun/   (200, Cloudflare)
https://mapple.uk/api/encrypt -> 301
mapple.uk A 104.21.66.88
```
Anything still pointing at mapple.uk is one redirect behind.

**The API answers our own requests — no Chromium needed.** Today mapple runs
only as a VM browser extraction (`/api/vm/api/providers/mapple/test`, measured
48.1s behind Chromium). Plain curl reaches the endpoint and gets a structured
error, which means it is parsing our body:
```
POST https://mapple.fun/api/encrypt   body {}
  -> HTTP 400 {"error":"Unsupported encryption request"}
```

**The old endpoint name is STALE.** The previously recorded contract
`{ data: {...payload, source}, endpoint: 'stream-encrypted', requestToken }`
no longer works. All three shapes below returned the same 400:
```
{"endpoint":"stream-encrypted"}
{"endpoint":"stream-encrypted","data":{"tmdbId":"1408162","type":"movie","source":"mapple"}}
{"endpoint":"stream-encrypted","requestToken":"","data":{...}}
```
The discriminator value changed with the domain. Current contract is being read
out of their shipped Next.js chunks; see the next entry when that lands.

**Not yet verified:** mapple's 2160p ladder. Still the only 4K source if it works.

### NetMirror placeholder guard now has tests

`masterMatchesTitle` was the only thing keeping the wrong film off the screen
and it had zero coverage, so it is now exported and tested against the manifest
captured above (`test/netmirrorPlaceholder.test.js`, 4 tests).

The subtle case the tests pin down: the decoy master's AUDIO renditions carry
the WANTED id in a `URI=""` attribute, so a parser that treated every id in the
file as a video id would accept the decoy. Only bare (non-`#`) URI lines count.
The guard also fails OPEN on HTTP errors, thrown fetches and non-master bodies —
it is a guard against one known decoy, not a general validator.

```
npm test (backend)   104 passed, 0 failed   (was 100; +4)
```

### mapple: full auth chain measured — works browser-free, but the stream is still withheld

Contract read out of their shipped chunks and then verified with plain curl. The
old note was wrong in the DATA KEYS, not the endpoint name: it is `mediaId`, not
`tmdbId`, and `source` is required.

**Step 1 — session.** GET the watch page with a cookie jar. All later calls must
reuse that jar; without it `/api/playback-init` returns 401 "Playback session
required".

**Step 2 — request token.** `POST /api/request-token` (no body) -> 200
```
{"token":"<b64>.<sig>","expiresAt":...,"deploymentVersion":"..."}
```
Claims decode to `{nonce, iat, exp, path}`; valid 6h.

**Step 3 — playback-init, twice (Proof of Work).**
```
POST /api/playback-init  {"mediaId":1408162,"mediaType":"movie","requestToken":"<tok>"}
 -> {"success":true,"requiresPow":true,
     "pow":{"challengeId":"<uuid>","challenge":"<64 hex>","difficulty":18}}
```
The solution goes back NESTED under `pow`, which is what I got wrong first —
flat `challengeId`/`nonce` fields are silently ignored and the server just
issues a fresh challenge:
```
POST /api/playback-init  {...same..., "pow":{"challengeId":"<uuid>","nonce":"<n>"}}
 -> {"success":true,"token":"<streamToken>","expiresIn":120}
```
Algorithm, from their own `/pow-worker.js`: find `n` where
`SHA256(challenge + n)` has `difficulty` LEADING ZERO BITS. Nonce is decimal,
sent as a string. **Cost measured in plain Node, no browser:**
```
difficulty 18 -> nonce 320084 in 176ms
difficulty 18 -> nonce 307607 in 168ms
difficulty 18 -> nonce 127189 in  72ms
```
So the PoW is NOT a reason to keep the 48s Chromium extraction.

**Step 4 — encrypt.** `POST /api/encrypt` -> 200
```
{"data":{"mediaId":1408162,"mediaType":"movie","tv_slug":"","source":"mapple"},
 "endpoint":"stream-encrypted"}
 -> {"url":"/api/stream-encrypted?data=<blob>","encrypted":"<same>"}
```
`tv_slug` is "" for movies, "{season}-{episode}" for tv. `endpoint` also accepts
`"next-episode-encrypted"`. No client-side secret: `process.env.ENCRYPTION_KEY`
is an unresolved webpack reference, crypto is server-side.

**Step 5 — GET the returned url** with `requestToken=` and `token=<streamToken>`
appended as query params -> 200.

**WHERE IT STOPS.** Every title returns the SAME sentinel, and `tmdb_id` comes
back "0":
```
{"success":true,"data":{"stream_url":"/api/playback-unavailable/I3e8F53s23zwcN-613tbemUl/master.m3u8",
                        "tmdb_id":"0","media_type":"movie","source":"mapple"}}
```
Identical path for 1408162, 693134 and 155 — it is a constant, not per-title.
Fetching it returns the site's HTML 404 page, not a manifest.

So: auth chain CONFIRMED working browser-free, stream delivery NOT obtained.
Something beyond the PoW still marks us as non-browser (TLS/JA3 fingerprint, an
ad-script side effect, or a header we are not sending). Do NOT re-derive steps
1-5; they are measured. The open question is only step 5's gate.

**2160p ladder: still UNVERIFIED** — no manifest has been obtained yet.

Repro script kept at `/tmp/mapple/chain.sh <tmdbId> [movie|tv]`, solver at
`/tmp/mapple/solve.js <challenge> <difficulty>`.

### CORRECTION + big finding: mapple needs NO browser at all, and 2160p is confirmed

Two corrections to what I wrote above, both from the user pointing me at
`~/Documents/Projects/ott` (a SEPARATE repo — the VM resolver, `apps/resolver`).

**1. I was wrong that the stream was withheld.** It was not a fingerprint gate.
`source: "mapple"` is only the DEFAULT front. mapple fronts many backends named
s1..s25 with overlapping catalogues, and the default simply did not carry those
titles — hence `tmdb_id:"0"` and the constant `playback-unavailable` sentinel.
`apps/resolver/src/resolver/mappleapi.js` already documents the measured order:
```
s9 6/6   s4 5/6   s17 5/6   s2 4/6   s25 3/6   ...   nothing above s25 ever hit
const RANKED = [9,4,17,2,25,3,5,6,10,12,19,1,24];
```
Also required and initially missing from my body: `requestToken` at the TOP
LEVEL of the `/api/encrypt` payload (not only inside `data`).

**2. The resolver still launches Chromium for one value it does not need.**
`apps/resolver/src/resolver/mapplesession.js` spends a measured ~13s booting a
browser purely to sniff a `requestToken` off the wire ("we read it off the wire
rather than trying to recompute it"). It never has to: `POST /api/request-token`
returns one over plain HTTP. `grep -rn "request-token" apps/resolver/src` -> 0 hits.

**Measured, browser-free, end to end** (`/tmp/mapple/nobrowser.mjs`):
```
bootstrap (cookie + requestToken, no browser):  500 ms     <- was ~13s w/ Chromium
1315772  source=mapple   714ms
1386315  source=mapple  1029ms
674      source=mapple   753ms
1408162  source=s9      4692ms   (default front missed; sweep found it)
```

**The 4K ladder is REAL** — this was the long-standing UNVERIFIED item:
```
#EXT-X-STREAM-INF:BANDWIDTH=18000000,RESOLUTION=3840x2160
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1280x720
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=640x360
```
and the 2160p variant resolves to a genuine VOD playlist
(`.../video_4k.m3u8`, `#EXT-X-PLAYLIST-TYPE:VOD`). mapple is the only 4K source.

Stream hosts seen: `source.jordanblackwell.bid`, `proxy2.jordanblackwell.bid`.
Signed urls carry `e=` (expiry) and `s=`; `e=1797552000`.

**Note on the domain:** `apps/resolver/config/providers.json` already has
`tiers.mappleapi.baseUrl = "https://mapple.fun"`, so THAT repo tracked the move.
The stale `mapple.uk` reference is only in this repo's test fixture.

### mapple video + CastleTV audio: PAIRS AND PLAYS (verified in a browser)

The obvious combination works: mapple brings the picture, CastleTV brings real
Telugu. Measured on 1408162.

```
POST /hybrid/pair {video: mapple(s9), audio: CastleTV castle-demux}
 -> 200  delta 0.2376849999473052  nudge 0
```

Fused master is correct — video rungs are mapple's, audio is all five CastleTV
languages, Telugu is DEFAULT, and the demux PTS shift is applied:
```
#EXT-X-MEDIA:TYPE=AUDIO,NAME="Telugu",LANGUAGE="tel",DEFAULT=YES,
  URI=".../castle-demux/fc1b329d.../audio-4.m3u8?pts=-1.520222"
#EXT-X-STREAM-INF:BANDWIDTH=4618828,RESOLUTION=1920x802,AUDIO="hybrid-audio"
  -> m3u8-proxy -> proxy2.jordanblackwell.bid   (mapple)
```

**Played in a real browser via hls.js** — this is the proof, not the manifest:
```
{ log: ["manifest parsed"], t: 16.83, paused: false,
  w: 1920, h: 802, level: 802,
  tracks: ["Hindi","Kannada","Malayalam","Tamil","Telugu"],
  active: "Telugu" }
```
No fatal errors. Telugu auto-selected from DEFAULT=YES.

**ffprobe WARNING that is NOT a bug.** mapple names its video segments
`media.html`, so ffprobe refuses them:
```
URL ... /media.html ... is not in allowed_segment_extensions
```
It only decoded the 5 audio tracks. Fetched directly the segment is fine —
`HTTP 200 size=262072 ct=video/mp2t`, first bytes `4740 0030` (0x47 TS sync),
`h264,video,1920,802`. Browsers go by content-type, so hls.js plays it. Do not
"fix" this by tightening segment extension matching — Castle and OneTouchTV
already ship `.jpg`-named segments for the same reason.

**Caveat on 4K for this title:** 1408162 resolves on front `s9` and tops out at
1920x802. The 3840x2160 ladder was seen on the default `mapple` front for other
titles (e.g. 1315772). So "mapple = 4K" is per-title, not universal — check the
ladder before promising 2160p.

### VM resolver removed (2026-09-22)

The player never needed it. `useResolve` imports `resolveLive` from
`lib/backend.js`, which calls plain `/api/streams` on the Express backend; the
VM's `resolveStreamLive` in `lib/api.js` was imported by NOBODY. That is why the
Servers menu kept working while `/api/vm/api/resolve/...` returned 401 on every
load - the 401 was noise from a dead path, not the cause of any bug.

**Deleted:** `lib/vmProxy.js`, `lib/vmAuth.js`, `app/api/vm/`, `app/api/resolve/`,
`app/api/m3u8/`, `app/api/seg/`, `app/api/cron/provider-repair/`, and the dead
`resolveStream` + `resolveStreamLive` from `lib/api.js`. Tests deleted with
them: `vmProxy`, `resolveProxy`, `operatorGate`, `mediaProxy`, `resolveLive`.

`/api/m3u8` and `/api/seg` were safe to drop because the Express side already
rewrites every url to its own `/m3u8-proxy?url=...` before the browser sees it -
`lib/backend.js playableUrl()` is a deliberate pass-through, and wrapping again
would have produced a relay pointed at a relay.

**Repointed:** `app/providers/page.jsx` now calls `/api/providers` directly,
which `next.config.mjs` already rewrites to `:8790`.

**Middleware:** the operator gate moved from `/api/vm/api/providers/*` to
`/api/providers/*`, and now checks the METHOD. A blanket match would 503 the
operator page's own GET, because `OPERATOR_SECRET` is unset on this machine and
an unset secret deliberately fails CLOSED. Reads open, writes gated:
```
GET  /api/providers            -> 200
POST /api/providers/x/test     -> 503   (no OPERATOR_SECRET)
GET  /api/vm/api/providers     -> 404   (gone)
```

**Endpoints with NO local equivalent** - measured on :8790, all 404:
`/api/stats`, `/api/validate`, `/api/sources`, `/api/embed`. Their callers
already treat failure as "no data", so they degrade rather than break. The
`/stats` page loses its numbers. `reportPlayback` still POSTs to a dead
`/api/playback-report`; it is fire-and-forget and three tests in
`playbackReport.test.js` assert that exact shape, so it was LEFT ALONE - making
it a no-op broke them for no user-visible gain.

**Verified after removal:**
```
web    npx vitest run   51 files, 530 passed, 0 failed   (was 592; -62 in 5 deleted VM test files)
web    npx next build   Compiled successfully, no /api/vm or /api/resolve routes
api    npm test         104 passed, 0 failed
browser /title/movie/1408162 -> playing, clock advanced 2.50s in 2.5s,
        1722x720, Server: CastleTV, Audio: Telugu, no page errors
```

## "showsst is not responding" — slow + unhelpful failure (2026-09-22)

**Reported:** intermittent "Couldn't start playback / showsst is not
responding", transport bar reading `1:06:55 / 0:00`.

**First hypothesis (WRONG, recorded so it is not re-tried):** that the message
was a FALSE ALARM from the switch backstop testing `v.paused` 1200ms after a
12s timer, and that `0:00` duration meant "manifest still loading". Disproved
by driving the real UI: every liveness signal stayed flat for 20s
(`dur:null w:0 rs:0 buf:0`). showsst really was dead.

**Actual root cause:** `d.whysosigmabro.fun` is TLS-intercepted by the same
Fortinet CA that blocks mapple.
```
d.whysosigmabro.fun -> CN=FG4H0FT922902630, O=Fortinet   <- forged
google.com          -> CN=WR2 (Google Trust Services)    <- real
api.themoviedb.org  -> CN=Amazon RSA 2048 M04            <- real
```
`/m3u8-proxy` answers 500: `unable to verify the first certificate`.
Not fixable in code — same class as the mapple block.

**The real DEFECT this exposed:** hls.js reports a failing manifest as
repeated NON-fatal `manifestLoadError`s and only turns fatal after its retry
budget. Measured console: four 500s spanning 54.3s -> 61.9s, no fatal event.
The viewer got a frozen frame and NO message for ~18s.

**Fix (two parts):**
1. `web/lib/player/useHls.js` — count `manifestLoadError` /
   `manifestLoadTimeOut` / `manifestParsingError`; escalate to `onFatal` at 2.
   Segment errors deliberately untouched (recoverable mid-playback).
2. `web/components/Player.jsx` `onFatal` — map those details to
   `"<provider> is not responding. Try another server."` instead of raw
   hls.js text. Uses existing `currentSourceRef` (line 115).
   Also made the 12s switch backstop evidence-based (videoWidth / buffered /
   duration / readyState) rather than trusting `v.paused`, which is legitimately
   true during a normal re-attach.

**Measured in the browser on movie/1408162:**
```
before: message after ~18-20s
after:  message after 8.0s  "showsst is not responding. Try another server."
healthy CastleTV switch: playing=true rs=4 w=1722 errShown=false  (no false alarm)
```
**Tests:** web 51 files / 530 passed; api 104 passed.

## Full provider sweep after server restart (2026-09-22, movie/1408162)

**The Fortinet TLS interception is INTERMITTENT, not permanent.** Re-measured
after a restart, the same hosts served genuine certs:
```
d.whysosigmabro.fun -> O=Google Trust Services, CN=WE1   (was Fortinet earlier)
mapple.fun          -> O=Let's Encrypt, CN=YE1           (was Fortinet earlier)
```
This is what "i see this sometimes" was: the block comes and goes, so a
provider dies and recovers with no code change. Do NOT conclude a provider is
permanently dead from one failed run — recheck the issuer.

**Resolve (6 streams):** castletv 1158ms, onetouchtv 251ms, showsst 348ms,
vaplayer 9432ms, mapple 11028ms. netmirror: no result.

**Manifest fetch:**
```
CastleTV x3   200   (1107 / 2373739 / 2372976 bytes)
showsst       200   3435 bytes
mapple        200   2032 bytes
VaPlayer      522   {"error":"M3U8 fetch failed: 522"}   <- upstream, still dead
```
mapple and showsst carry IDENTICAL bandwidths (715546/2501623/4618828) -
same upstream source behind different fronts. Neither has EXT-X-MEDIA audio,
so Telugu must come from pairing with CastleTV.

**Browser (the surface that counts):**
```
mapple    playing 640x268  rs=4  advanced 6.00s/6s  unmuted  Audio=Telugu CHECKED
          -> mapple + Telugu pairing VERIFIED END TO END (first time)
showsst   playing 1722x720 rs=4  advanced 4.00s/4s
VaPlayer  failed at 5.0s "VaPlayer is not responding. Try another server."
CastleTV  playing 1722x720 rs=4
```
Audio menu on mapple: Hindi / Kannada / Malayalam / Tamil / Telugu, Telugu checked.

**The manifest fast-fail fix behaves correctly in both directions:**
dead VaPlayer caught in 5.0s (was ~18s); live mapple/showsst NOT false-flagged
despite mapple needing ~16s to first frame.

## Servers menu: duplicate ordinals + double tick (2026-09-22)

**Reported with screenshot:** two rows ticked at once, and "CastleTV 1"
appearing twice.

**Bug 1 — ordinal reset per ceiling.** `labelOf` keyed its counter by
`provider|quality`, so each ceiling was its own group and the numbering
restarted. Reproduced on movie/912649:
```
before: CastleTV 1,2,3,4 (720p) then CastleTV 1,2,3,4 (480p)   <- 4 dup labels
after:  CastleTV 1..8 across both ceilings, duplicateLabels: []
```
Fix: key the counter by provider name alone, across the whole list.

**Bug 2 — two ticks.** `selected={c.id === currentId}` ticks EVERY matching
row, and a duplicate id is reachable: useResolve merges late providers by
PROVIDER NAME (lib/player/useResolve.js:237 and :306) while ids are minted by
array INDEX in lib/backend.js toSource(). Two checked radios is also invalid
ARIA. Fix: resolve to a single `selectedIndex` via findIndex and compare by
position, which makes a second tick unrepresentable regardless of the data.
`-1` (no tick) is correct while a pair plays — pickPair sets the id to
`pair-<video>-<audio>`, matching no row by design.

Tests: sheetRows 6 -> 8 (added "ticks exactly one server row even when two
sources share an id" and "ticks no server row while a cross-provider pair is
playing"). Updated "numbers same-provider rows that share a ceiling", which
had encoded the OLD per-ceiling rule the screenshot disproved.
Web suite 530 -> 532 passed.

**Audio "Default" — NOT reproduced as broken.** On movie/912649 the badge read
Telugu, the menu offered Telugu/Hindi/English/Tamil with Telugu checked, and
picking Telugu kept playing at 1728px rs=4. "Default" is AudioMenu.jsx:43
`active?.name || 'Default'`, shown when `currentAudio` matches no track id -
i.e. a source carrying no in-file audio (showsst, mapple, vaplayer all ship
`selectableAudio:false`). Still to be reproduced on the exact source the
screenshot was taken on.

## Multi-movie provider sweep (2026-09-22)
```
id        title       n   telugu  selectableAudio  providers
1408162   Suriya46    6   3       1   CastleTV:3,showsst,VaPlayer,mapple
1195506   -           7   0       0   mapple,showsst,VaPlayer,CastleTV:4
1315772   -           6   3       1   CastleTV:3,mapple,showsst,VaPlayer
974453    Absolution  3   0       0   mapple,showsst,VaPlayer
1084736   Colors      5   0       0   mapple,showsst,VaPlayer,CastleTV:2
533535    Deadpool    6   3       1   CastleTV:3,mapple,showsst,VaPlayer
912649    Venom3     11   2       0   CastleTV:8,mapple,showsst,VaPlayer
1241982   Moana2      6   0       1   mapple,showsst,VaPlayer,CastleTV:3
```
CastleTV is the ONLY provider supplying Telugu. mapple/showsst/vaplayer all
return `languages:[]` and `selectableAudio:false`, so every Telugu result on a
non-Castle picture depends on the pairing path.

## Socket leak: pool wedged, "cannot play anything" (2026-09-22)

**Symptom:** every request to :8790 answered `socket hang up` (ECONNRESET at the
Next proxy). Pool log showed `[pool] active=9 queued=0 free=0` steady - NOT at
the 256 maxSockets ceiling, so it was never a capacity problem.

**Root cause:** node-fetch keep-alive returns a socket to the agent free list
only when the body is fully READ or DESTROYED. Five paths threw a response away
without touching its body, so each leaked one socket permanently:
```
proxy/proxyServer.js:168  prefetchSegment   if (!resp.ok) return;
proxy/proxyServer.js:403  /m3u8-proxy       !response.ok -> res.json(...)
proxy/proxyServer.js:721  subtitle proxy    !resp.ok -> res.json(...)
proxy/proxyServer.js:684  /ts-proxy         !resp.ok && !=206   <- SEGMENT route, worst
proxy/proxyServer.js:574  /ts-proxy HEAD    headers used, body never settled
```
A provider that merely ERRORS leaks on every attempt - VaPlayer answers
Cloudflare 522 on every request, so ordinary use drained the pool.

**Fix:** added `discardBody(resp)` helper and called it on all five abandon
paths. Verified: under 30 forced 522s the pool now rises and FALLS
(`active=11 free=0` -> `active=10 free=2`); previously it only climbed.
Restarting the API is a workaround, not the fix - it was needed because the
leaked sockets are unrecoverable in-process.

## /hybrid/pair 409 on Gandhari (movie/1355228) - NOT a code bug

User reported `{"error":"not pairable","reason":"the two sources disagree on
runtime, or neither carries audio renditions"}`.

Measured with describeStream:
```
mapple    seconds=7330.93  video=true  audio=false renditions=0
CastleTV  seconds=7008.29  video=true  audio=true  renditions=4
delta     322.64s (5m 23s)   tolerance 15s (DURATION_TOLERANCE_SECONDS)
```
The audio side HAS 4 renditions. The refusal is purely the duration gate
(utils/hybridStream.js:344 `if (delta > tolerance) continue;`). The two
providers ship genuinely DIFFERENT CUTS, 5m23s apart. Muxing them would drift
audio badly by the end, so refusing is correct behaviour.

**Improved the message** (lib/media/hybridRoutes.js) to name which gate refused
and by how much:
```
{"error":"not pairable","reason":"the two sources are different cuts: 323s apart",
 "videoSeconds":7331,"audioSeconds":7008,"deltaSeconds":323,"audioRenditions":4}
```
TRAP hit while building this: the first version re-ran describeStream and
reported "no audio renditions" for the source that had just described 4. The
urls are SIGNED and short-lived, so the refetch returned null. The diagnostic
now refuses to name a cause when the re-measure fails, rather than guessing.

Tests after all of the above: api 104 passed, web 532 passed.
