# NetMirror integration — 2026-11-21

## What changed

Android resolves NetMirror's authenticated TV catalog directly on the device's
IP alongside its other cooperative providers. Discovery, OTP exchange,
search/post/episode/player requests form one session. `111111`, supplied and
verified by the owner, is the initial device OTP; a local `netmirror.otp` value
can override it. The token is memory-only, scoped to the discovered API, and is
never sent to the Chitram backend, public configuration, logs or media CDN.
The supplied OTP is not guaranteed to remain accepted upstream.

Backend `providers/netmirror.js` uses the same TV protocol when
`NETMIRROR_OTP=111111` is configured in its deployment environment. It exchanges
on an explicit `status: otp` challenge, caches the issued token in memory,
and renews once per challenged operation. When unset, the previous backend
behavior is retained. This change does not clear an existing IP refusal,
throttle or request budget; a token does not establish that a blocked VM can
reach the service. No deployment, backend restart or device installation was
performed for this change.

The website consumes the existing normalized stream schema, so authenticated
backend results require no new frontend credential handling. Android uses the
public `netmirror` section of `/api/resolve-config` for endpoints, budgets and
TTLs, with bundled defaults when the backend is unavailable. Public config
contains neither an OTP nor an issued token.

## Playback and languages

All matching Netflix, Prime Video and Hotstar catalog/dub rows are retained,
with unique device source IDs. Existing TMDB title/year checks and wrong-video
master checks remain in place. Ordinary failure in one dub does not discard
later dubs. Global refusal, repeated authentication failure, substituted-video
responses and budget exhaustion stop the chain rather than create request
storms.

Actual HLS `EXT-X-MEDIA` audio renditions supply selectable languages. A single
authoritative catalog language can label a master without audio renditions,
but does not invent selectable tracks. HLS subtitle playlists stay embedded
in the master for Media3; they are not side-loaded as VTT files. API credentials
and API cookies use a separate client from media fetching.

The device playback race accepts lists of rows from each resolver. Late
listeners await every job, including a job that completes between the first
snapshot and listener setup. NetMirror device rows remain visible even when
the VM also returned NetMirror, since their catalogs/languages can differ.
Playback recovery refreshes the full row set, keeps the current source ID when
available, and otherwise chooses an untried language-ranked row. Failed
original rows are retired when switching to a different ID.

## State/branch audit

| State | Producers and consumers | Recovery and limits |
|---|---|---|
| API base | APK bootstrap `token_hash` → API calls | HTTPS validation, TTL; device config rotation clears base/session/metadata/player state |
| User token | OTP exchange → search/post/episodes/player | Single-flight; bounded retry on `otp`; no credential redirects; never media/public config |
| Metadata | Search/post/episodes → title/season/dub selection | Cached separately; auth challenges and HTTP failures are not empty catalog answers |
| Player rows | Player + master → race, menus, language ranking, recovery | Short device TTL, refresh on failure, unique per-catalog IDs; no complete cache entry for partial lookup |
| Timeout/cancel | Request/resolve scope → subsequent job | Device timeout preserves completed rows; caller cancellation propagates and releases session mutex |
| Throttle/refusal | HTTP429/403, decoy, failed auth → next lookup | Cooldown/budget and existing VM guard remain; no repeated title sweeps |

## Phone browser findings

The mobile `check.php` result is a content URL, not a TV user token. The server
issues `addhash`; client JavaScript forwards it, rather than calculating a
credential. An HTTP-only first-party verification navigation changed a status
flag from `c:n` to `c:y`, without issuing a new cookie. The homepage still
remained gated after another 25 seconds; no advertiser was contacted and no
successful completion was observed.

Static APK inspection found no Chrome-cookie import or browser authentication
callback. The WebView retains its own cookie and polls server state. A browser
visit can change that shared server state without transferring cookies back
into the APK. Full mobile verification remains unverified and is not used as
an automatic fallback. See the adjacent evidence and native-flow notes.

## Verification and limits

Backend suite: **416/416 passed**. Final Android release suite: **155 passed,
5 skipped, 0 failures** (160 total), including 16 NetMirror tests. Signed
Chitram 1.2.5 (version code 18) assembled successfully.

Node tests exercise search/post/episode/player OTP challenges, single-flight,
TTL/origin/OTP isolation, stale rejection, retry limits, API redirect policy,
HTTP failures, language preservation and media credential isolation.
Android MockWebServer tests cover token reuse/renewal, all catalog rows,
configuration rotation, season selection, bad-video cooldown, sibling dub
failure, audio/subtitle metadata, cancellation, multirow race behavior,
VM-title fallback, and preservation of earlier catalogs on timeout.

Earlier live evidence proved `111111` issued a TV token. This implementation
has not yet been verified with real playback on Xperia; Xperia was not
connected during this work. Token issuance alone does not prove the upstream
will serve the correct video or every claimed audio language.

A single bounded live check (one title, Netflix catalog) completed discovery,
OTP exchange, search, post and player with HTTP200. The returned HLS playlist
also returned HTTP200 and video file ID81252029 matched the requested
Ala Vaikunthapurramuloo (2020). Catalog language was Telugu; the master had
no separate EXT-X-MEDIA audio renditions. This verifies URL resolution and
identity checks, not actual playback or multi-language switching.

## Website verification — 2026-11-21

Enabled `NETMIRROR_OTP` in the ignored local backend `.env`. Started the local
API on 127.0.0.1:8790 and Next dev on localhost:3200; no remote deployment or
production process restart. A real request through the website's Next rewrite
to `/api/streams/netmirror/movie/628241` returned two proxied Telugu sources:
MP4 720p and HLS Auto. A `netmirror-budget` partial-result marker remained
visible in the API response; additional catalogs were not swept or budget
limits disabled.

Fixed NetMirror source IDs in `web/lib/backend.js`: provider/index IDs could
collide or change between aggregate and supplemental replies. NetMirror now
uses URL+quality identity, matching the hook's merge identity. Tests first
reproduced both the collision and index-instability failures, then passed.
The same mapping covers movies, series, cached answers and late arrivals;
existing signed-URL refresh still retains the selected row's ID.

Browser verification used an isolated context and forwarded only the aggregate
stream request to the real NetMirror provider-specific route to isolate it
from other providers. Title metadata, source responses, proxy requests and
media bytes were live. The video advanced past 2 seconds with a 960x540 rendered
picture and readyState 4; controls showed Telugu. The source menu showed
NetMirror 1 Auto and NetMirror 2 up to 720p, with exactly one checked. Playback
was paused and the test context closed. Multi-language switching was not
verified live because this title exposes only Telugu.

Verification: full web suite: 893 passed; full backend suite: 416 passed. The live
website/VM remains unchanged; enabling it there requires deployment of the
code and `NETMIRROR_OTP` environment setting, and the existing VM IP-refusal
guard may still apply.
