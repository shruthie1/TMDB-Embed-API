# Audio language, server selection, and pairing — design

Date: 2026-11-21
Status: draft for owner approval
Surfaces: Node API, web player, Android APK (phone + Fire TV)

## Why

Audio pairing fails most of the time, and the player often shows "server source
slow." The two are linked: implicit pairing/donor attempts run inside the start
path, and a failed or slow pair makes the whole resolve look slow. The owner's
direction:

1. Never initiate pairing automatically.
2. Regular server selection must be simple: pick a server, see every audio
   language that stream carries, switch to that track instantly (no re-fetch).
3. Stream to language and language to stream mapping must be seamless, both ways.
4. Pairing (grafting an audio track from another source) is a separate, explicit,
   deliberate journey, with the same UX on APK and web.

## Goals

- A stream's audio languages are known and shown without probing.
- "Show me Telugu" lists every stream that already has Telugu, and switching to
  one is instant.
- The common case (switch audio inside one stream) never touches pairing.
- Pairing is explicit, legible, cannot fail silently, and never blocks normal
  playback or slows the start.
- One mental model and one flow across web and APK.

## Non-goals

- Changing how streams are discovered/ranked (parallel fetch, breakers,
  byteCheck stay as they are).
- Fixing the Fire TV frozen-buffer recovery (already shipped, 1.2.36 / 74b5a8e).
- New providers.

## Anti-goals (what would make this a failure)

- Any automatic pair attempt on start or on a plain server switch.
- A "slow" start caused by trying to pair before the picture plays.
- An "Add Telugu audio" control that fails after the user taps it.
- Language inferred from track order/index instead of real metadata.
- Losing an audio/language tag anywhere (project rule 1).

## Current state (from the 2026-11-21 survey, static reading)

- The stream list carries `audio[{language, codec, channels}]` but NOT the
  rendition identity (no URI / GROUP-ID / NAME / index). So "switch to Telugu"
  and "pair Telugu" have no handle to match on. (`utils/streamSchema.js`)
- Most providers ship `selectableAudio:false` and `audio:[]`; mapple hardcodes
  `languages:[]`. (`providers/mapple.js`, `showsst.js`, `onetouchtv.js`)
- `?capabilities=1` would fill `audio[]` from the real manifest, but neither web
  nor APK sends it. (`apiServer.js`, `lib/media/capabilities.js`)
- Server-side auto-pairing is OFF since 2026-09-22 (H14). Implicit pairing still
  fires client-side: web tries one donor before a plain switch
  (`web/components/Player.jsx:~1610`); APK has the matching path.
- Language matching misses `te` (only `tel`/`Telugu`); several paths fall back to
  track 0 (wrong language) on no match (`hybridStream.js:671-676`,
  `HybridPair.kt:89`, `useHls.js:238`).
- The "slow" message is purely time-based (`FINDING_SLOW` after
  `LOADING_SLOW_HINT_MS`), so anything that lengthens resolve — including an
  implicit pair attempt — surfaces as "server source slow."

## The model: one audio index, two lookups

Build a single in-memory index per title, shared in shape across all surfaces:

- Normalise every language to one code (accept `te`, `tel`, `Telugu`, `tel-IN`
  → `te`). One helper, used everywhere a language is read or compared.
- For each discovered stream, record the audio languages it actually carries,
  each as a real selectable track (in-manifest rendition) OR a whole-stream
  language (single-audio stream). Keep the rendition handle (group id / name /
  index) so selection is data, not a guess.
- Two derived lookups, both O(1):
  - stream → [languages]  (for the server menu)
  - language → [streams]  (for "show me Telugu")

This index is the seamless mapping. Both the server menu and a future
"languages" menu read from it; nothing probes the network to answer.

## Regular server selection (the common path, must be instant)

- The server menu lists each stream with the languages it carries (from the
  index). Selecting a server plays that stream; if it is multi-audio, switching
  language selects the in-manifest rendition — instant, no re-fetch, no pairing.
- Picking a language (language → streams) jumps to a stream that already has it,
  switching server only if needed, keeping position.
- Pairing is never reachable from this path.

## Pairing (separate, explicit, checked on demand)

- Pairing only exists for a language missing from the playing stream, where we
  must graft an audio rendition from a donor onto the current video.
- The control (e.g. "Add Telugu audio") is shown whenever the language is
  missing from the playing stream. The donor check runs ON TAP, not on start and not
  up front — pre-validating every video is too heavy (owner decision 2026-11-21).
- Tapping shows its own progress. If no donor works, it says so clearly and the
  already-playing picture is untouched. It never runs on start or on a plain
  switch, so it can never slow the start.
- Same control, copy, and states on web and APK.

## The metadata contract change (the root enabler)

Seamless mapping and reliable selection both need the list to carry rendition
identity. Extend each `audio[]` entry to `{language, name, groupId, uri,
default, codec, channels}`, read once from the master on the server (reuse
`capabilities.js audioFromManifest`); always attach it for HLS rows; stop
hardcoding mapple to empty. Mirror the field in APK `data/Models.kt` and the web
track model. Pairing eligibility (`selectableAudio`, donor validity) becomes a
data flag the client reads, not a probe it runs.

## Approaches (pick one)

A. Client-only. Keep the server contract; have each client probe manifests to
   build the index and decide pairing. Rejected: duplicates logic three times,
   still probes the network (the thing we want to stop), and can't pre-validate
   donors cheaply.

B. Server builds the index + pre-validates donors; clients render it. The API
   returns the audio index AND a per-video list of confirmed donors, so pairing
   never fails after a tap. Rejected (owner, 2026-11-21): pre-validating every
   video is too heavy for the payoff.

C. Server carries rendition identity (so selection/mapping is seamless); pairing
   checks the donor ON TAP (RECOMMENDED). No pre-validation, no probing on start.
   The server menu and language lookup read returned data; the pairing control
   calls the existing pair endpoint only when tapped, and reports failure
   cleanly without disturbing playback. Less backend work than B, no slow-start,
   pairing may occasionally fail after a tap (acceptable — it is explicit).

Recommendation: C, delivered in two steps so value lands early —
  Step 1: metadata contract + normalise language + seamless mapping + REMOVE all
          implicit/auto pair attempts (web and APK). This alone fixes the
          "slow" start and makes in-stream language switching reliable.
  Step 2: the explicit "Add <language> audio" journey (on-tap donor check),
          identical on web and APK.

## What's left to the builder

- Exact UI copy and placement of the server/language menu and the pairing control
  on each surface (follows existing player menu patterns).
- The on-tap pairing failure copy (what the user sees when no donor works).
- Where the index is cached and invalidated (with the stream cache).

## Decided

- Pairing control visibility: ALWAYS shown when the language is missing; donor
  checked on tap, not pre-validated. (Owner, 2026-11-21 — pre-validation too
  heavy.)
- APK merge: server-fused pair first when the backend answers (it has offset
  correction and a duration check). On-device merge is the fallback when the
  backend is down or unreachable. The on-device merge refuses a duration delta
  over the server's `DURATION_TOLERANCE_SECONDS` (15 s, `utils/hybridStream.js:48`),
  picks only a track in the asked language, and never plays the donor alone.
  (Owner, 2026-11-21: "if client can do that's better"; controller ruling.)
- Device fails to play an accepted pair: try the next donor inside the caps
  (3 donors, 15 s per try, 30 s total). All spent: restore the previous stream,
  position and audio, and show the failure copy. (Owner, 2026-11-21.)
- Entries: one per language missing from the playing stream that another
  server carries. Every such language, Telugu first, then the Step 1 index
  order. On TV every entry is D-pad reachable and the list scrolls inside the
  menu. (Owner, 2026-11-21.)
- Fixed-audio servers (whole-stream audio, no selectable tracks) are left out:
  never a donor, never an entry. (Owner, 2026-11-21.)
- A device-resolved APK row (no server headers) is never used by the
  server-fused path. The on-device merge can serve it, so it is a donor, and a
  playing device-resolved row gets an entry, only on the on-device path.
  (Controller, 2026-11-21.)
- The unreachable APK `"pair"` branch is reused for the journey, not deleted.
  (Controller, 2026-11-21.)
- Copy, final and byte-equal on web and APK (`…` is U+2026):
  - Group: "Add audio from another server"
  - Entry: "Add {lang} audio from another server"
  - Checking: "Checking {server} for {lang} audio ({n} of {total})…"
  - Success: "{lang} audio added from {server}."
  - Failure: "No server has working {lang} audio. Playback is unchanged."
  (Controller, 2026-11-21.)

## Step 3 (owner decisions, 2026-11-21, binding)

Plan: `docs/superpowers/plans/2026-11-21-audio-pairing-step3.md`.

- D1. Entries follow "Your languages". "Add {lang} audio from another server"
  shows only for a language the viewer picked in "Your languages" that the
  playing stream lacks. Telugu first. No pick (Skip, or nothing stored) means
  Telugu. Stored as web `localStorage['chitram:prefs:v1'].langs`
  (`web/lib/prefs.js` `getPrefs`) and APK `LanguagePrefs` key `prefs:v1`
  (`android/.../data/Store.kt:32`, `langs()`). This replaces the Step 2
  "every missing language" entry rule above.
- D2. The audio menu "Other servers" group lists only rows that carry one of
  the viewer's languages. A row with no known language (shown as just "Audio")
  is hidden. "In this stream" rows are never filtered. Every server stays
  reachable from the server picker.
- D3. Progressive mp4 picture (NetMirror hakunaymatata, showsst). APK pairs on
  the device: `MergingMediaSource` of the mp4 video and the donor HLS audio
  rendition, extending the Step 2 Task 6 on-device fallback. The duration gate
  reads the mp4 length from the `moov/mvhd` box with ranged reads and keeps the
  15 s tolerance. Web hides the Add entry while an mp4 picture plays. The
  server answers an mp4 video half with its own 409 reason, not "could not be
  read back".
- D4. Server diagnostics. A failed pair logs each side's measured seconds,
  upstream HTTP status and content type. Each gate branch logs one greppable
  `[pair-gate]` line. `/ts-proxy` wrappers unwrap like `/m3u8-proxy`, so
  `missingHeaders` is true only when headers are really missing. The double
  negative "neither source could not be read back" is fixed.
- D5. Cut mismatch. When the two lengths differ beyond 15 s, the server
  measures the real offset instead of refusing: it decodes short low-rate mono
  windows of the picture's own audio and of the donor audio near the start,
  cross-correlates their loudness envelopes, then checks a middle point and a
  point near the end. All three agree within 1 s: pair at that offset (covers
  extra content at the start, the end, or both). They disagree: refuse with
  "different cut". The duration-match path (delta 15 s or less) is unchanged
  and never measures. The measurement fits inside the 15 s per-try cap.
  Movie 1511417 (video 13506 s, audio 13434 s, TMDB 13440 s) was refused
  although the padded rule allows it; the first server task reproduces it.
- D6. Stream-down recovery is in scope (source:
  `.superpowers/sdd/2026-11-21-audio-pairing-step2/offline-stuck-rca.md`).
- Unchanged: caps 3 donors, 15 s per try, 30 s total; copy byte-equal on web
  and APK (`…` is U+2026); never drop an audio, video or language tag; Telugu
  first; never auto-pair; donor checked on tap only.
