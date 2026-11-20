# TMDB-Embed-API — working notes

Operational context for anyone (human or agent) working in this repo. Everything
here is MEASURED unless it says otherwise. Dates are when the measurement was
taken; re-measure before trusting an old number.

## Running it

| Piece | Port | How |
|---|---|---|
| Express API | 8790 | `node apiServer.js` — plain node, NOT pm2 |
| Next.js UI | 3200 | `npm run dev` in `web/` |

- Restart the API: `pkill -f "node apiServer.js"` then
  `nohup node apiServer.js > /tmp/api8790.log 2>&1 &`.
  `POST /api/restart` returns 401 (`AUTH_REQUIRED`) without a session.
- **`/tmp/api8790.log` uses CARRIAGE RETURNS.** Always read it as
  `tr '\r' '\n' < /tmp/api8790.log | grep -a ...` — a plain `grep` sees one line.
- Never run `npx next build` while `next dev` is running.
- UI route is `/title/[type]/[id]`. `web/next.config.mjs` rewrites
  `/api/streams/*`, `/hybrid/*`, `/m3u8-proxy`, `/ts-proxy` to `API_ORIGIN`
  (default `http://localhost:8790`).
- Playback path: `web/lib/player/useResolve.js` → `web/lib/backend.js` →
  `GET /api/streams/:type/:tmdbId`.

Test baselines (2026-11-16, both green):

```
api   npm test         195 passed, 0 failed
web   npx vitest run   67 files, 642 passed, 0 failed
```

## The one rule that keeps being relearned

**Never lose audio or video information to save latency.** An unlabelled stream
is invisible to the language-first ranking, so dropping a language tag does not
give the viewer a slower Telugu result — it gives them no Telugu result.

This was violated once (non-blocking ffprobe, see below) and reverted on user
instruction: *"blocking is fine, never loose audio or video info"*.

## Browsers cannot set Referer or Origin

`Referer` and `Origin` are forbidden headers: neither `fetch` nor `<video>` can
set them. Any origin that gates on them MUST be proxied. This single fact is the
root cause of both the mapple pairing failure and the NetMirror browser failure.

Measured on NetMirror's CDN:

```
no Referer                     HTTP/2 429  text/html 185b
Referer videodownloader.site   HTTP/2 206  video/mp4, x-oss-cdn-auth: success
```

curl can send the header, Chrome cannot — which is why a stream "works in the
API but always fails in the browser".

`enableProxy` (`utils/config.js:124`, default **false**) is a ROUTING POLICY,
not a statement about whether the proxy exists. Proxy routes are always mounted
(`apiServer.js`) because `/hybrid/pair` needs them. With the policy off,
header-gated streams are still proxied and everything else goes direct:

```
[proxy] 5/6 stream(s) routed via proxy (header-gated origins); the rest direct
```

`apiServer.js:586` — `streamHeaders.rememberStreams(streams)` MUST run BEFORE
any proxy rewriting, because both branches strip `headers`. Recording after
would store proxied urls with no headers and silently re-break `/hybrid/pair`.

## NetMirror

Two completely different paths that return different things. Do not conflate.

| | `/api/embed-tmdb/` (`fetchNetflix`) | `newtv` platform path (`fetchPlatform`) |
|---|---|---|
| Platforms | Netflix only | `PLATFORM_ORDER` = netflix, primevideo, hotstar (upstream also has disney) |
| Returns | `{url, resolution, size}` mp4 | `player.video_link` HLS |
| Quality | real rungs (`720p`, `1080p`) | `'Auto'` — HLS master decides |
| Language | **none in the API response** | **`postData.lang`** — authoritative list |
| Video | real | see the decoy problem below |

### embed-tmdb carries no language — ffprobe supplies it

The API returns only `{url, resolution, size}`. The tags were in the files all
along (measured 2026-09-23):

```
628241 Ala Vaikunthapurramuloo  stream1 aac language=tel
912649 Venom: The Last Dance    stream1 aac language=eng
```

`lib/media/mp4AudioProbe.js` reads them with ffprobe over HTTP (seeks to the
moov atom — a few hundred KB, does NOT download the film). Needs the `-headers`
CRLF blob for header-gated origins. Returns RAW ISO codes; `normaliseStream()`
in `utils/streamSchema.js` owns the mapping (`LANG_CANON` has `tel: 'Telugu'`).
Returns `[]` not null on failure — "nothing known", caller carries on.

Only the SMALLEST rung is probed: the resolution rungs are the same cut and
share one audio track.

Cost: **7330–9226ms cold, ~0ms warm** (30 min cache keyed on hostname+pathname,
ignoring the signed query).

**This probe BLOCKS on purpose.** A non-blocking version was tried and reverted
— it cut NetMirror to ~4s but shipped `languages:[]` on the request the viewer
actually sees. See the rule at the top.

### The newtv 220884 clip is a RATE-LIMIT response, not a missing title

newtv's API, search, post.php and player.php all work. Metadata is real:

```
AlaVaikuntha/netflix     langs=[Telugu]                     video_link=YES
AlaVaikuntha/primevideo  langs=[Hindi]                      video_link=YES
Oppenheimer/hotstar      langs=[English/Bengali/Tamil/Kannada/Hindi/Marathi/Telugu]
```

When THROTTLED, the video rungs are replaced by a shared clip while everything
else stays correct for the real title. Full master from a throttled request
(2026-09-23, movie 81252029 Ala Vaikunthapurramuloo):

```
#EXT-X-MEDIA:TYPE=SUBTITLES,...,URI="https://subscdn.top/subs/81252029/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080,...
https://s21.freecdn4.top/files/220884/1080p/1080p.m3u8?in=unknown::ni
```

The tells that this is a THROTTLE and not an absent title:
- subtitles are keyed to the REAL id (`subs/81252029/`), not to 220884;
- other titles show per-title audio (`audioIds=[81602830]` for Oppenheimer)
  against the same 220884 video — real audio, real subs, substituted video;
- the video url carries `?in=unknown::ni` — an identity/entitlement marker;
- the variant's segments are `2560_000.jpg` … 60 segments x 10s = 600s. A
  notice clip served as `.jpg` like every other segment, so it plays rather
  than erroring;
- HTTP status is **200** throughout. Nothing downstream can detect it from
  status codes alone — only the content is wrong.

**Probing causes it.** This session made dozens of newtv calls (3 platforms x
10 titles, plus rapid retries and chain traces) and thereafter got 220884 on
every request, including a single request after several minutes idle. An idle
gap of minutes does not clear a limit accumulated that way. An earlier note in
this file concluded "newtv video is a decoy, path unusable" — that was WRONG,
and it was wrong because the measurement was taken from an already-throttled
client.

Consequences for the code:
- `masterMatchesTitle` (`providers/netmirror.js:425`) correctly rejects the
  substituted master, so we never serve the clip. Keep it.
- But rejecting is the wrong RESPONSE to a throttle: the title is really there.
  This wants backoff / retry / request-budgeting, not permanent rejection.
- Do NOT benchmark or sweep newtv. Each sweep poisons subsequent measurements
  for an unknown window. Test with ONE request and state that it is one.

STILL UNMEASURED: what clears the limit (time, IP, `Usertoken`, OTP). Note that
`player.status = otp` (not `ok`) and upstream sends `Usertoken: ''` — the
obvious next lead, and cheaper to test than waiting out a limit.

Other NetMirror facts:
- `fallbackHls: /api/loffe/tt...` → **404, upstream headless-browser crash**
  (`browserType.launch: Target page, context or browser has been closed`).
  Not our bug, not recoverable from our side.
- Rung counts vary per title and are mostly 1. Sweep of 15 titles (2026-09-23):
  only Endgame and Wonka returned 2 (`720p,1080p`); 3 returned 0.
- When several rungs DO arrive they surface as N separate rows, not as `levels`
  on one stream, so there is no quality menu. `levels: []` for NetMirror today.
- No ABR/auto for NetMirror: `container: "mp4"`, a single fixed encode. Auto
  quality is an HLS multi-variant behaviour.

### NetMirror state, 2026-10-03 (6 NetMirror-path requests total, no sweep)

- **Netflix (embed-tmdb) works** from VM1: 628241 -> 1 row (Telugu 720p mp4)
  in 2.2s. Gandhari (1355228) is not on Netflix - 0 there is correct.
- **newtv (prime/hotstar/disney) is refused upstream**: discovery
  (`mobiledetects.com/checknewtv.php`) still answers and points at
  `https://tv.imgcdn.kim`, but `newtv/search.php` returns `403 text/html
  "Page Not Found"` - logged by us as a JSON parse error. Same from VM1 and
  Vercel. The `ott` project's resolver uses identical paths, so there is no
  newer protocol to copy. Not fixable from our side until the cause is known.
- **Why NetMirror vanished from the list**: `GATED_BY_DEMUX` skips it whenever
  castle-demux offers Telugu. On Vercel demux was off, so the gate never held;
  on the VM it holds for most titles. Fixed by making NetMirror its own flow
  in the web app (`Player.jsx`, once per title after playback starts, merged
  via `mergeSources`), so the first picture still never waits on it.
- Two bugs found on the way, both fixed: `mergeSources` matched rows by
  provider NAME (a second NetMirror row overwrote the first); the per-provider
  route skipped the header-gated proxy step and returned NetMirror's raw mp4,
  which its CDN refuses without a Referer. Both routes now share
  `routeStreamsForBrowser`.
- `lib/api.js` `listSources` is a stub returning null, so the Player's existing
  "re-ask after 9s on TV" refresh has never added anything.
- `providers/__nm_s.js` (an unused older copy of netmirror.js) was deleted
  2026-11-16; the registry now lists only files with a mapped entry function.

## Latency

Providers run CONCURRENTLY; total resolve time is set by the SLOWEST one, so a
single hung origin used to gate everything.

`providers/registry.js` — `PROVIDER_DEADLINE_MS`, default **20000ms**. Sized
above the worst measured cold run (netmirror 9226ms) with headroom; it exists
only to catch a hung origin. A first attempt at 6000ms cut NetMirror off and
silently dropped its Telugu tag — a correctness loss dressed up as a speed win.

Measured per provider (2026-09-23): onetouchtv 99ms, showsst 252ms, castletv
485–1541ms, mapple 1160–3214ms, vaplayer 2822ms, netmirror 7330–9226ms cold.

End to end: `628241` cold 17.4s / warm 3.6s, `912649` cold 7.0s / warm 3.6s —
with languages intact.

### VaPlayer dedupe probe

`toStreams` was 8332ms of an 8.5s fetch. All three dedupe probes hit their
8000ms timeout and returned null, because `urbansolardiyprojectshub.site`
answers **522** (Cloudflare origin unreachable, confirmed 19s to fail). The
probe is only an optimisation — it dedupes tokens pointing at the same media —
so waiting 8s to learn nothing was pure cost. Timeout is now
`VAPLAYER_PROBE_TIMEOUT_MS`, default **2500ms**. VaPlayer 8577ms → ~2820ms.

### ts-proxy progressive open range

`progressiveOpen` grew the upstream range by `openChunkKB` (4MB) on EVERY
`bytes=0-` request, per URL, unconditionally. hls.js probes an mp4 with
`bytes=0-`, reads a few hundred KB and closes, so the window kept widening on
abandoned probes. Measured before the fix on a NetMirror mp4:

```
headers 206 +597ms / +840ms / +4337ms
aborted 8, done 2
one request pulled 41218136 bytes (41MB) and threw all of it away
```

That self-inflicted traffic — not Node, not the extra hop — was the latency.
Growth is now re-armed only after a client drains a window
(`res.writableEnded`). After:

```
headers 206 +55ms
aborted 1, done 1
largest discard 2569831 bytes
```

Ruled out, do NOT re-tread:
- CORRECTED 2026-11-20: destroying a node-fetch v2 body does NOT free its
  socket (it is a PassThrough; the real response just pauses). `discardBody`
  now aborts the request first, and `pipeUpstream` uses it on client hang-up.
  Prod before: `[pool] active=16 queued=0 free=0` for 8h with no viewers. A body that drained cleanly must NOT be destroyed or the
  keep-alive socket never returns to the pool.
- The segment cache is URL-keyed, so it correctly never serves ranged mp4s.
- The proxy is NOT a throughput bottleneck for HLS segments. Same cold segments:
  `VIA-PROXY 2.65s/2.26s/3.62s` vs `DIRECT 2.15s/2.78s/1.95s` — roughly a wash.
  CastleTV `.jpg` segments are 74–188ms to headers, unaffected by the above
  (`looksLikeHlsSegment` skips the HEAD/probe preamble).

## Hybrid pairing (mapple video + CastleTV audio)

`movie/1290190` "Lokah Chapter 1: Chandra" — three stacked bugs, all fixed and
browser-verified:

```
(a) headers dropped:  mapple master no-hdr 404 / with-hdr 200 RESOLUTION=3840x2160
(b) duration gate:    mapple 9376s vs Castle 8974s, TMDB runtime 151min = 9060s
                      delta 402s vs tolerance 15s
                      after: {"delta":402.29,"padded":true,"runtimeSeconds":9060}
(c) proxy unmounted:  video variant 404 "Cannot GET /m3u8-proxy"
                      after: video variant 200 2265072b / telugu audio 200 312696b
```

`utils/hybridStream.js` gates on TMDB runtime: a pair whose halves BOTH match
the runtime within `RUNTIME_MATCH_SECONDS` (600) may exceed the strict 15s
tolerance up to `PADDED_TOLERANCE_SECONDS` (900), and is flagged `padded`.

The 402s padding is NOT auto-correctable (ruled out): mapple segments are a
uniform ~2.1s throughout with no outlier block — distributed, not one ad break.
A PTS probe measured only `0.088111s`. The viewer nudge bar is the only lever;
`AudioMenu` warns when `padded`.

`describeStream` IS exported (`utils/hybridStream.js:414`) — an earlier note
claiming otherwise was wrong.

hls.js `startLevel` set at MANIFEST_PARSED is too late — the first fragment is
already in flight at the advertised top rung. `HLS_CONFIG_HYBRID` sets
`startLevel: 0` plus `abrBandWidthFactor: 0.7` / `abrBandWidthUpFactor: 0.8`.
The up-factor is deliberately NOT the TV profile's 0.5: that measured stuck at
360p for 36s with 87s buffered ahead.

## CastleTV muxed audio in production (browser-side, no ffmpeg)

Castle ships ONE MPEG-TS per title with every language muxed in as its own AAC
PID, tagged in the PMT (1508168: 0x101-0x105 = hin/mal/tam/tel/kan). The
playlist declares no `#EXT-X-MEDIA`, and hls.js plays only the first AAC PID.
castle-demux fixes that server-side but is OFF on Vercel (no ffmpeg, no
persistent job store), so prod played Hindi with no Audio menu.

`web/lib/player/tsAudio.js` + the fragment loader in `useHls.js` read the PMT
from the first main fragment and swap the chosen PID into hls.js's slot in
every packet header. Verified 2026-10-03 on chtrm2 against the real file's
per-language AAC: 154/154 decoder samples Telugu at start; after switching,
67/67 Kannada then 36/36 Telugu, 0 cross-language. Limits: AAC (0x0f) tracks
only; ciphertext/fMP4/native-HLS (Safari) fall back to the default track.

## Hybrid audio (Castle Telugu + another provider's video) needs a VM

Measured 2026-10-03 on 1355228 (Gandhari): every pairing with Castle audio is
refused on the Vercel API - `409 "the audio source carries no switchable audio
renditions"` - although showsst/VaPlayer and Castle are the same cut (7000s vs
7008s). The hybrid path needs ffmpeg (castle-demux, ptsRebase) and in-process
state (castle-demux jobs, `/hybrid/:id` jobs, streamHeaders) - none of which
serverless provides. Same code in Docker: VaPlayer+Castle -> 200, Telugu
DEFAULT, audio-3 rendition with `pts=-1.478556`, segment ffprobes as `aac tel`;
in the browser a Source click on VaPlayer paired and kept playing in Telugu.

Run the API from `docker-compose.yml` (fixed 2026-10-03: copies lib/ and
routes/, installs ffmpeg, Node 24, PORT=8787 - PORT outranks the 8790 in
user-config.json). Behind https set `PUBLIC_BASE_URL`; every absolute url now
goes through `lib/runtime/publicBase.js` (eight call sites used to ignore it).
Then point the Vercel web project's `API_ORIGIN` at that https origin.

showsst's CDN (d.phantomflix.net) answers `429` wrapped in a 503 once an IP has
made a burst of requests; that is what failed showsst pairing locally, not code.

## Production API on VM1 (since 2026-10-03)

The API runs on VM1 of the Telegram fleet (187.127.137.163; access per
`~/Documents/Projects/local/docs/FLEET-DEBUGGING-RUNBOOK.md`). Session
survival of the fleet outranks this app: never restart the fleet to fix it.

- Public: `https://tmdb-187-127-137-163.sslip.io` (sslip.io = free DNS; Let's
  Encrypt cert, certbot.timer renews). Vercel `chtrm` has `API_ORIGIN` = that.
- Code: `/root/tmdb-embed-api` (shipped tarball, not a git checkout). Secrets in
  its `.env` (600). Admin password rotated off the public default; plaintext in
  `/root/tmdb-embed-api/ADMIN_PASSWORD` (600).
- Process: PM2 app `tmdb-embed-api`, `127.0.0.1:8787` only (ufw is inactive, so
  never bind 0.0.0.0), `--max-memory-restart 500M`. NOT in `pm2 save` - saving
  would rewrite the fleet's dump; after a reboot start it again by hand.
- nginx: `/etc/nginx/sites-available/tmdb-embed-api.conf`, proxy_buffering off.
- ffmpeg 6.1.1 from apt; installed with `NEEDRESTART_SUSPEND=1` after an
  `apt-get -s` showed 149 new packages and 0 upgrades.
- Rollback: set Vercel `API_ORIGIN` back to `https://tmdb-embed-api-sand.vercel.app`,
  redeploy web, re-alias chtrm2.

## Reliability knobs (2026-11-16)

| Env | Default | Effect |
|---|---|---|
| `FIRST_ANSWER_GRACE_MS` | 400 | With `PRIMARY_PROVIDERS` set, once a preferred-language stream exists the rest get this long, then the answer goes out with `partial: true` and they finish in the background. No Telugu stream yet: it still waits for the primaries. |
| `PRIMARY_PROVIDERS` | unset | Recommended `castletv,netmirror` (not set on the VM as of 2026-11-20). Unset = wait for every provider. One prod call (628241, 2026-11-20): Castle Telugu at +0.8s, NetMirror 7.5s, mapple 16.0s with 0 streams, answer 16.5s. The web follows a `partial: true` answer with one `?full=1` call. |
| `PROXY_RATE_LIMIT_PER_MIN` | 600 | Per IP, shared by /m3u8-proxy, /ts-proxy, /sub-proxy. 0 = off. |
| `SHUTDOWN_GRACE_MS` | 8000 | SIGTERM/SIGINT drain. PM2's default kill_timeout is 1600ms, so set `--kill-timeout 10000` on the app to use it. |
| `CASTLE_DEMUX_FETCH_TIMEOUT_MS` | 8000 | Castle playlist/probe fetch on the /api/streams path. |

- `/api/health` returns uptime, memory (MB), per-provider breakers, `openBreakers`, uncaught/unhandled counts.
- Every response has `X-Request-Id`; log lines a request causes start with `[<id>]`.
- Boot exits 1 on an invalid port or malformed `PUBLIC_BASE_URL`; other config problems log `[startup][warning]`.
- `utils/user-config.json` is gitignored (it held the TMDB key). The loader falls back to the tracked `utils/user-config.example.json`. The key belongs in `.env` as `TMDB_API_KEY`.
- Web: `/api/streams` retries 5xx/429/network errors twice (0.8s, 2.5s); complete answers are cached per title in sessionStorage for 4 min; any fatal hls.js error fails over to the next source before showing an error; the stall ladder is 12/25/40s and also fails over a source that never started.

## Deploying the API to VM1

`SSHPASS=... scripts/deploy-vm.sh` (add `--dry-run` to stage and check only).
It ships `git archive HEAD` (no web/, tests, secrets), keeps the VM's `.env`,
`utils/user-config.json`, `ADMIN_PASSWORD` and node_modules, runs
`node --check`, backs up to `/root/tmdb-embed-api-backups/`, restarts only
`tmdb-embed-api`, health-checks local and public, and rolls back on failure.
It never runs `pm2 save`.

## Deploying the web app

`chtrm2.vercel.app` is a MANUAL alias, not a project domain: `vercel --prod`
moves `chtrm-shettysais-projects.vercel.app` but leaves chtrm2 on the old
build. After every deploy run
`vercel alias set <new-deployment-url> chtrm2.vercel.app` and confirm with
`vercel inspect chtrm2.vercel.app`.

## Other ruled-out items

- VaPlayer 522 is upstream Cloudflare — identical with the proxy out of the path.
- showsst `master.m3u8` 522 on 1273049 is upstream, unrelated.
- `vi.spyOn` cannot observe ESM-internal calls.
- NetMirror returned 0 streams for 1290190, 811941, 1273049 on a refresh sweep.

## Conventions

- Work on `main`. Do not create branches, commits, pushes or merges unless asked.
- Measure before claiming. Static inspection is not behavioural verification —
  exercise the surface the user actually looks at and paste the output. If a
  stronger check is unavailable, say why and label the result `unverified`.
- Playwright: the server menu closes between separate `browser_evaluate` calls,
  so open-menu + click must happen in ONE call. Keep observation loops under
  ~45s to stay inside the tool timeout. The play control may read "Resume" when
  watch progress exists.

## Security (outstanding)

- Febbox clientId/secret and a Supabase auth token for the account owner were
  exposed in a working session and **should be rotated**.
- TMDB v3 key lives in `web/.env.local`; confirmed gitignored
  (`git check-ignore -v web/.env.local` → `web/.gitignore:3:.env*`).
