# Provider selection and playback UX proposal

Status: design proposal, not an implemented shared player. 2026-11-21.
Source inspection covers all 17 registered providers. No provider availability
sweep or new live upstream tests were performed for this design. Existing
uncommitted implementation work has not been discarded or treated as shipped.

## Decisions from this discussion

- Every server follows the same selection contract, not a NetMirror exception.
- Provider checks/resolution originate from the viewer's client, not the VM.
- Initial eligible API checks can run in parallel. A single playing stream does
  not imply serial provider requests. Keep per-provider session/rate controls.
- Start immediately on the first confirmed Telugu stream. Fifteen seconds is
  a soft preference window: if Telugu is not ready then, play the best available
  usable stream and name its actual language. If no usable stream is ready,
  show progress plus server choices/Retry; do not promise playback at second 15.
- A later Telugu result is offered as Switch to Telugu, never a forced mid-film
  replacement. Opening a menu does not trigger new checks. Selecting another
  server uses its cached results or resolves only that selected entry.
- Audio pairing is optional advanced behavior, not a dependency of language
  selection or server switching. Prefer in-file track switching; otherwise
  switch to a complete synchronized stream with the requested language.

## What the current code actually supports

The registry has 17 providers. `/api/providers` exposes stable IDs and enabled
flags, but lacks display names, client-mode capabilities and independently
selectable subentries. Current aggregate resolution fans out from the backend.
The single-provider API route can resolve a provider, but still resolves on
that backend; it is not a client-direct implementation.

Five providers currently have Android-native resolver paths: CastleTV,
NetMirror, Mapple, VaPlayer and MultiMovies. MultiMovies is currently gated by
VM health, which must cease being an eligibility dependency in a client-direct
experience. The other twelve need actual device resolver work before they can
be advertised as client-supported. The ordinary website currently gets resolved
streams from the API; its existence does not establish direct browser support.
VaPlayer has a separate embedded-player fallback, not a generic API resolver.

Consistency means identical meanings, states and selection behavior wherever
supported, not pretending every client can execute every provider.

## Browser feasibility is a prerequisite, not a hidden VM fallback

Native apps can make header-aware HTTP calls and keep provider sessions on the
device. Ordinary browsers must obey CORS, forbidden-header rules and cookie
restrictions. Several current modules assume arbitrary User-Agent/Referer/
Origin headers, server-side extraction, cookies or sessions. Moving those modules
behind `fetch()` on a browser does not make them work. `no-cors` gives an opaque
response and cannot power stream/audio discovery; a service worker does not
remove these origin restrictions.

Each provider needs an explicit tested client mode:

1. Direct API: the browser/native client can resolve and read the provider.
2. Provider player: a verified embeddable player loads on the viewer's device.
   Chitram does not pretend it controls tracks that live in an opaque frame.
3. App-only: the native resolver works, browser access is unsupported.
4. Not implemented/unsupported on this client: retain an honest explanatory row.

Use a provider-hosted player only when an actual embedding contract exists;
not all extraction inputs are valid embeddable players. No silent VM/proxy
fallback is part of the proposed client-direct check flow. Provider credentials
stay on the viewer's device. Existing title/catalog metadata services are
separate from provider resolution and must not receive provider credentials.

## Information architecture

The Server menu is a stable list of enabled, applicable providers, available
before any stream is resolved. A provider row is a request target, not proof
that the current title is present there. IDs stay stable across devices,
requests, URL refreshes and display branding. In particular, registry Showbox
cannot be reconciled by the emitted names Febbox Direct / Febbox FID alone.

Hierarchy:

- Server → provider.
- Optional provider subgroup only when independently selectable: NetMirror
  catalogs, or real named upstream sources whose resolver supports selection.
- Resolved stream/release only when the provider actually returns meaningful
  alternatives. Do not multiply rows for every signed-URL refresh.
- Audio, Quality and Subtitles remain separate controls for the selected stream.

Current subgroup constraints matter. NetMirror currently resolves all catalogs
internally. Videasy queries CDN/LaMovie/Meine; ZXC queries four internal sources;
Mapple races thirteen fronts and returns a winner. None currently honors a
selected subgroup in the generic resolve contract. Those interfaces must exist
before clickable independent subgroup controls are implemented. MultiMovies
currently integrates VidBolt only: comments naming other hosts are not choices.
Mapple's internal fronts should remain an implementation detail unless a
provider-specific recovery control is later justified.

Show names such as Netflix, Prime Video, a real release name, quality and known
language. Avoid unexplained Server 1/Server 2 when meaningful metadata exists.
When only opaque alternatives exist, Alternative 1/Alternative 2 is acceptable
as a last resort, with an actual quality/audio summary.

## Initial Auto flow

1. Render provider rows and preferred audio immediately. Restore a remembered
   valid provider preference without allowing it to override Telugu-first.
2. Run eligible client-supported startup lookups concurrently. Independent
   providers may run in parallel; each still owns its safe internal fan-out,
   session, timeout and rate constraints. Unsupported clients do not make
   doomed requests, and no check goes through the VM.
3. Start one stream as soon as its playable audio is confirmed Telugu. Do not
   wait for the slowest provider. Do not claim a release-name hint is a verified
   selectable track. Unknown language remains unknown.
4. At the fifteen-second soft deadline, start the best usable fallback already
   found and show the actual language. If there is no stream yet, keep honest
   loading, Retry and Server choices visible.
5. Results already in flight can populate the stable list/cache without changing
   playback. Do not start a new provider sweep after playback is established.
6. Offer a later confirmed Telugu option rather than changing the stream without
   consent. Choosing it restores the current position where the cuts match.

Preferred start order and parallel eligibility should be configurable and based
on measured client outcomes, not static claims that a provider is always fast,
always available or always Telugu. Do not reshuffle the open server list as
results arrive. Distinguish provider order from ranking the discovered streams.

## On-demand switching

Selecting an unchecked provider starts that one check and leaves the panel open.
Current video continues while resolution happens. Repeated activation shares
one in-flight request. Selecting another target supersedes the earlier pending
selection; a late result cannot hijack the user's later choice.

When alternatives are ready, show the actual streams/release variants. Selecting
one prepares the switch, preserves position and desired audio where compatible,
and transfers the Playing checkmark only when the new source is active. A failed
manual selection does not silently substitute a third provider. Retain or resume
the previous usable stream and place Retry next to the failed target.

Audio consequences must be explicit: In this stream is an immediate track
change; Switches to NetMirror means the picture/source changes too. Keeping a
particular picture while pairing another provider's audio, if retained at all,
is an explicitly advanced choice and may fail independently.

Quality is the actual current HLS ladder or actual available file encodes. An
advertised provider maximum is not a selectable rung. File-based quality changes
may require replacing the stream; preserve position and state that consequence.
For an embedded provider player, show Use player controls instead of inventing
Chitram-level audio/quality/subtitle controls that cannot be commanded.

## Shared states and product copy

| State | Display | Action and playback behavior |
|---|---|---|
| Not checked | Not checked | Select to check this title/episode |
| Checking | Checking… | Existing playback stays; no duplicate request |
| Ready | Actual variant count/audio/quality | Expand or choose the actual stream |
| Playing | Checkmark + Playing | Independent from an Updating state |
| No title match | Not available for this title | Retry remains possible |
| Temporary failure | Could not check | Retry this entry, preserve prior good results |
| Needs account/session | Sign-in needed | Supported device-local setup, no shared-secret UI |
| Not supported here | Not supported in this browser/device | Explain and offer a supported client/server |
| Embedded player | Opens provider player | Explain controls are inside that player |
| Partial result | Some streams found | Load more/check again only for this provider |

Only confirmed no-match is Not available for this title. A blocked request,
unknown language, unsupported codec and authentication error are different
states. Failed refresh can coexist with Ready cached entries and Playing.
Episode/title change scopes results and cancels irrelevant pending intent.

## Consistent surfaces

| Surface | UI | Input rules |
|---|---|---|
| Desktop web | Anchored menu/compact side panel | Mouse/keyboard; retain focus and selected state |
| Android phone | Bottom sheet in portrait; compact side panel in landscape | Large touch targets; no dismissal on Check |
| Mobile browser | Bottom sheet with safe-area spacing | Same labels/states, capability-aware rows |
| Android TV | Large right panel | D-pad; selected row initially focused; Back returns child→provider→playback |
| TV browser | Same TV hierarchy around supported player | Visible focus; honest native/embedded limitations |

Control order: Server, Audio, Quality, Subtitles. Stable focus IDs and retained
scroll position are required while results arrive. Never hide Server merely
because only one stream has been found or because discovery is still running.

## Implementation prerequisites after UX approval

1. Shared safe provider descriptors and client capability catalog. No credentials.
2. Client resolver ports and direct-browser feasibility tests per provider.
3. Provider/subentry selection contract instead of provider-internal fan-out.
4. Per-provider, title/episode-scoped state/cache and requested-vs-playing selection.
5. Parallel initial Auto race with the fifteen-second preference window.
6. Shared menus and truthful actual-track metadata; preserve rendition identity.
7. Touch/remote focus, cancellation, retry and source-switch acceptance checks.

Vixsrc currently parses but drops audio/caption metadata; source normalization
also strips some subentry/rendition identity. Fix propagation before promising
those fields. Browser/TV capability testing must precede availability labels.

## Validation required for implementation

A parallel startup produces Telugu before 15s; fallback with an actual known or
unknown language at 15s; no stream at 15s; late Telugu offer without auto-switch;
checking while another source plays; repeat activation; selecting B while A is
pending; session expired; provider rate pause; no match; unavailable browser;
refresh failure with usable cached results; episode change; signed URL rotation
without duplicate rows; single-source provider; real multi-source provider;
in-file audio; whole-stream language switch; quality/captions missing on the
new stream; embedded-player limitations; TV Back and focus during late results.

The accompanying interaction proposal uses simulated outcomes only. It is not
proof of direct-browser capability or current upstream availability.

## Provider-by-provider source audit

# Chitram provider inventory for UX design

Read-only source inspection, 2026-11-21. No upstream requests or live playback checks. Every capability below means code-supported, not availability on a particular title. Root: `/Users/SaiKumar.Shetty/Documents/Projects/TMDB-Embed-API`.

## Shared architecture and constraints

17 providers are registered in `providers/registry.js:11-29`. Every entry exposes movie and TV/series handling; this is an interface capability, not equal catalog coverage. `registry.js:283` lists stable lowercase IDs and enabled flags. `apiServer.js:371` exposes this immediately through GET /api/providers; it currently provides only name and enabled, without display names, subentries, capabilities, account status, or title availability.

GET /api/streams/:provider/:type/:tmdbId (`apiServer.js:1099`) already resolves one chosen provider. It shares caches and in-flight work with aggregate resolution, supports refresh=1, drops expired URLs, applies filters and browser routing, and exposes providerError with count=0 for failed outcomes. It cannot request a named internal catalog/front/server independently. Some providers fan out internally even when the client chooses only one provider.

Standard providers have a default 20-second registry wall-clock cap (`registry.js:245`); the underlying provider promise continues after timeout (`registry.js:248`). Showbox follows a special branch before that cap (`registry.js:144-177`) and therefore lacks that shared deadline. Registry timeout/error/partial markers and per-provider endpoint providerError distinguish some transient failures from empty catalogs; they do not yet provide a complete typed user-facing state contract.

Canonical stream metadata (`utils/streamSchema.js:142`) contains provider, quality, levels, languages, catalogLanguages, audio, subtitles, container, selectableAudio, codecs/videoCodec. Unknown language is allowed. Fallback extraction from release labels still exists. This means languages does not uniformly mean confirmed player tracks. Canonical audio currently retains language/codec/channels only, dropping rendition identity, name, and URL; the player still needs actual manifest/native track discovery. Unknown levels means not yet known, not that only one quality exists. No reviewed registered resolver deliberately emits an iframe fallback: embed pages are extraction inputs; outputs are playable URL rows whose exact container can remain unknown until inspected.

## Provider capability inventory

All rows support movie and episode-oriented series code paths. B = backend; D = Android device path.

| ID / display name | Output and entries | Audio truth and subtitles | Session / resolution / timing evidence |
|---|---|---|---|
| showbox / Showbox | FebBox direct/file-ID links; multiple files and qualities; container inferred from URL; not an iframe UI. | No structured audio/subtitle fields on reviewed emitted rows; release-name language inference only. | TMDB key required; configured FebBox cookies selected per request; uncookied size filter exists. B only. Special registry branch has no shared 20s cap. `providers/Showbox.js:1940,2033,2057,2085,2135`; `registry.js:145-177`. |
| 4khdhub / 4KHDHub | Direct extracted file links from multiple hosts, quality/release rows; inferred container, often file-oriented. | No structured audio/subtitles on final rows; labels may yield inferred languages. | B; multi-step extraction/optional URL validation with 10/15/30s HTTP steps, under common cap. `providers/4khdhub.js:91,145,232,1879`. |
| vixsrc / Vixsrc | One HLS master with best advertised quality; rendition ladder available in actual master, not emitted as levels. | Parser reads audioTracks and captions but DOES NOT attach them to streams; audioTracks discarded locally and returned subtitles discarded by entry function. Current API metadata cannot promise them. | Backend extraction of expiring page token, no interactive login path; 10s HTTP steps. `providers/vixsrc.js:39,78-127,171-179`. |
| videasy / Videasy | CDN, LaMovie, Meine internal servers; Meine movie-only; returns all distinct URLs/quality labels, format inferred from URLs. | No structured audio or captions propagated. | B; seed-backed requests and fresh-seed retry, 8s steps. Internal server selection unsupported by API. `providers/videasy.js:17-21,148-209`. |
| vidlink / Vidlink | Multiple API qualities; HLS/MP4/WebM or unknown inferred container. | Structured language hints and audio arrays when upstream supplies them; selectableAudio requires >1 audio row; no captions propagated. | B; token/encrypted request preparation; 8s HTTP steps. `providers/vidlink.js:45-69,79,94,112-131`. |
| dahmermovies / DahmerMovies | Progressive MP4/MKV release files; separate releases and qualities, file size. | Languages/codec/channels and multi-audio flag inferred from release filename, not enumerated playable tracks; captions empty. | B; worker-routed direct files; 8/10s HTTP steps, common cap. `providers/dahmermovies.js:147,209-239`. |
| streamflix / StreamFlix | One chosen title/episode on multiple reachable CDN bases; Auto quality, URL-inferred container. | No structured audio/captions; subtitleHint in title is a hint, not a usable subtitle track. | B; remote data/config plus Firebase episode lookup, 6/8/10/20s request steps. `providers/streamflix.js:23,32,43,81,106-164`. |
| vaplayer / VaPlayer | Multiple deduplicated HLS URLs, ladder metadata and codecs; fallback raw URL if probes fail. | Language inferred from filename; known implementation comment says no audio renditions and und muxed audio; no captions emitted. | B + D. IP-sensitive tokens; Android refresh resolves token on device. HTTP steps 8s, probe 2.5s; D default budget 20s. `providers/vaplayer.js:34,218-279`; `android/.../resolve/OnDevice.kt:122-136`. |
| castletv / CastleTV | Separate language/resolution requests deduplicated by physical media identity; progressive/muxed file URLs, container inferred. Multiple real files kept, metadata-only quality rows rejected. | Language from API track selection; same-file language tags are merged. Does not itself enumerate native file audio tracks; actual switchability must be discovered in player. Captions extracted from upstream subtitles. | B + D, device runs on every start when available. Decrypted API/session setup; preview/permission denied excluded. 12s API steps; D budget 25s. `providers/castletv.js:246-326,480-565`; `android/.../resolve/OnDevice.kt:103-116,171`. |
| hdghartv / HDGharTV | Active direct link rows sorted by quality; per-episode lookup; container inferred. | No structured audio/captions emitted. | B; 10s fetch default. `providers/hdghartv.js:13,45-63,63-123`. |
| netmirror / NetMirror | Direct MP4 qualities plus HLS catalog/dub entries. Dynamic catalog registry, fallback Netflix/Prime Video/Hotstar; separate dubbed catalog matches preserved. All catalogs resolved internally. | Direct files probed for real audio; HLS AUDIO renditions retained. catalogLanguages separated from actual track metadata, but single catalog language/title dub can label a stream without track enumeration. Direct/embed path captions supported; platform row does not attach captions. | B + D; authenticated newTV session/OTP flow, cooldown/call budget, cached/partial and last-good results. B common 20s cap versus D default 50s budget; D captures completed rows on budget expiry. `providers/netmirror.js:363-437,722,804-824,836-884,987-1039,1218-1400`; `android/.../resolve/OnDevice.kt:55-79`; ResolveConfig.kt:89-104. |
| onetouchtv / OneTouchTV | Multiple deduplicated source rows; HLS default or upstream type, advertised quality. | Explicit empty audio/languages; caption tracks propagated. Source names are not track languages. | B; retry transient failures and last-good recovery; 15s HTTP timeout. `providers/onetouchtv.js:20,103,236-255,380-419`. |
| zxcstreams / ZXCStreams | Icarus, Orion, Athena, Berkas; all internal servers queried. HLS/MP4 rows ranked with MP4 preference and qualities. Final output loses explicit type/size/server fields, leaving labels and URL inference. | No structured audio/captions emitted. | B; server token step and host rediscovery; 6/10s discovery steps. `providers/zxcstreams.js:1-23,131-175,196-215,269-299`. |
| showsst / showsst | Mirror/API source + separate progressive quality files or HLS; explicit container probe, fixed audio. HEVC quality entries filtered. | Explicit unknown language and selectableAudio=false. Captions propagated. | B; origin/header-aware resolver and container probe; common cap. `providers/showsst.js:31,89-113,153-186`. |
| mapple / mapple | Thirteen internal fronts raced; FIRST viable row wins, not a selectable list of 13. HLS with levels/codecs, sometimes 4K. | Explicit unknown languages and selectableAudio=false; no captions emitted. | B + D. Host-scoped cookie/session token bootstrap cached 10min. B step 8s with per-front/probe budgets, common cap. D default 25s, language-wait behavior differs. `providers/mapple.js:42-80,197,380-430`; `android/.../resolve/ResolveConfig.kt:48-57`. |
| multimovies / MultiMovies | Only VidBolt integrated (Nexus/Vidrift/VIDOUT/Filmu are comments, not available choices); HLS masters with ladder/codecs. | Actual HLS audio renditions, known-dead rendition probes filtered; captions from manifest. | B + D, D only when VM down/not expected to answer. 10s API /8s master /5s probes; D budget 15s. `providers/multimovies.js:1-21,44-46,105-129,192-239`; `android/.../resolve/OnDevice.kt:47,118-121,172`. |
| vidrock / VidRock | Named upstream servers (e.g. Nova/Atlas), each decrypted HLS master checked for variants; levels/codecs. | Only manifest-confirmed languages; upstream language hint retained internally as statedLanguage but canonical normalization drops it. Actual audio renditions available. Captions explicitly empty. | B; 10s API, 8s master, one retry on master 403; common cap. `providers/vidrock.js:1-32,49-50,80-110,123-162`. |

Android paths in table abbreviate `android/app/src/main/java/com/chitram/app`.

## Selection boundaries and state issues

- NetMirror, Videasy, ZXCStreams and Mapple expose internal structure, but none accepts an independently selected subentry through the generic resolve API. VidRock identifies server in its display title, not a canonical server ID. New entry selectors require explicit discovery/resolve contracts first.
- MultiMovies supports VidBolt only. Showing every upstream site's brand as an enabled selectable entry would misrepresent implementation.
- Showbox returns `provider: Febbox Direct` / `Febbox FID` (`Showbox.js:2062,2091`), while top-level registry ID is showbox. Canonical normalization preserves that provider value. Stable providerId must be separate from stream label/subsource; otherwise a stable provider list cannot reconcile its ready rows reliably.
- `normaliseStream` collapses source identity to provider/title/URL and selected metadata. It strips arbitrary server/platform/source IDs, rendition IDs and statedLanguage. URL refresh is not a stable entry identity. A providerId + entryId + streamId contract is needed for persistent UI selection.
- Android `OnDevice.resolveAll` keeps multiple rows only for NetMirror; all other device providers use resolveOne (`OnDevice.kt:55-58`). Backend may return multiple Castle/VaPlayer rows where Android keeps one. A shared UX cannot assume equal inventory without this being resolved deliberately.
- Android device failures return missing rows under circuit breaker after three failures, 5min doubling to 30min (`OnDevice.kt:149-186`). Static provider choices should remain visible with temporary availability state; otherwise backend and device inventories visually disappear for different reasons.

## Five priority UX implications

1. **Stable provider list, lazy resolution.** Show enabled providers immediately from config; label untried entries “Not checked.” Resolve only the selected provider. A provider being listed does not imply this title exists there. Keep playback running until an alternative is ready and committed.
2. **Separate provider → optional entry → stream from playback controls.** Server is the source selector; internal catalogs/fronts appear only when genuinely selectable. Audio, Quality and Subtitles describe current playback, with an optional explicit “Find another version” action for a language that needs a different file/provider.
3. **Preserve metadata truth.** Offer actual player tracks as switchable Audio choices; mark single-file language labels as version information. Unknown audio remains unknown. Catalog languages and release-name hints must not inflate a working audio menu. Vixsrc metadata propagation and canonical identity gaps are prerequisites for trustworthy badges.
4. **Design failures as recoverable per-entry states.** Distinguish no match, slow/timeout, temporary restriction/retry time, account required, codec unsupported, and partial results. No spinner for the whole server list, no disappearing rows, no forced pairing. Show “More versions may be available” when results are partial; retry is explicit and budget-aware.
5. **Same state model on every surface; adapted geometry.** Desktop side panel, phone bottom sheet, TV focusable full-height panel all show the same provider order, active/pending choice, language/quality/caption availability and retry meaning. Backend/device differences remain diagnostic details; a successful full multi-audio stream never waits for hybrid audio pairing.

## Recommended next design boundary

Design the stable all-provider selector and current-stream Audio/Quality/Subtitles first. Show NetMirror catalogs and other providers' subentries as a second level only after backend/device adapters can discover and resolve those entries independently. Predeclared static catalogs/fronts can be displayed as “Not checked” only if the chosen entry can actually be requested; otherwise they are informational labels on resolved versions.

## Claude design consultation and visual refinement

The user requested the installed Claude Code CLI for a design-only second
opinion. It received sanitized provider analysis, this proposal, existing
`web/app/tokens.css`, player/menu CSS, token documentation and Icon.jsx. Tools
and hooks were disabled, no source edits delegated. Its recommendations are
saved in `CLAUDE-PROVIDER-REVIEW.md` with source-audit corrections.

The review preview now uses Chitram's existing monochrome dark token values,
spacing/radii/type/focus primitives and exact existing icon vectors. Desktop
uses an anchored player menu, phones a bottom sheet, TVs a right panel with
separate focus and selected indicators. Icon identities remain Server racks,
Audio waveform, Quality bars and Subtitle frame, matching Icon.jsx/Glyphs.kt.
The standalone preview snapshots these assets only for review; implementation
should import the existing design system, not create duplicate token/icon sets.

This is still a proposal. No further application player UI implementation,
deployment, commit or push was performed for this design request.
