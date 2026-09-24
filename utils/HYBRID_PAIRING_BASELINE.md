# Hybrid pairing: mapple video + CastleTV Telugu audio

Measured 2026-09-23 on movie/1290190 (Lokah Chapter 1: Chandra), proxy
`enableProxy: false`, api on :8790, next dev on :3200.

## Three separate bugs, found in this order

### 1. Pair route fetched the manifest without provider headers
`web/lib/backend.js` `pairSources()` posts `{url, provider, quality}` only.

    mapple master  no-hdr    404  21b   {"error":"Not found"}
    mapple master  with-hdr  200  853b  RESOLUTION=3840x2160

`describeStream` returned null, and the 409 said "the two sources disagree on
runtime" - a wrong cause. Fixed with `lib/media/streamHeaders.js`: the server
records url -> headers at resolve and refills them in `/hybrid/pair`. Headers
are NOT accepted from the client (SSRF surface, and the server already knows
them first-hand).

### 2. Duration gate refused the same film with different padding
    mapple  2160p  9376s = 156m16s
    Castle   720p  8974s = 149m34s   7 renditions incl. Telugu
    TMDB runtime   151min = 9060s
    delta 402s vs DURATION_TOLERANCE_SECONDS 15

Runtime equality was the only same-film test. Replaced with a runtime-anchored
gate: when TMDB's runtime vouches for BOTH sides individually
(RUNTIME_MATCH_SECONDS 600) a gap up to PADDED_TOLERANCE_SECONDS (900) is
allowed and the plan is flagged `padded`. Strict 15s gate still applies when no
runtime is available.

After: `{"delta":402.29,"padded":true,"runtimeSeconds":9060}` HTTP 200.

### 3. Unmounting the proxy broke every hybrid
`enableProxy` conflated "route all streams through the proxy" (policy, off)
with "the endpoint exists" (infrastructure, required). A hybrid's remote video
variant MUST be proxied - the browser cannot set `Referer: mapple.fun`.

    video variant  HTTP 404 149b   Cannot GET /m3u8-proxy
    telugu audio   HTTP 200 312696b

Now always mounted; `enableProxy` only decides whether ORDINARY streams are
rewritten.

## The proxy is NOT the bottleneck (ruled out)
Cold 2160p segments, same segment both ways:

    seg300  VIA-PROXY 5452752b 2.65s   DIRECT 5452752b 2.15s
    seg301  VIA-PROXY 5173384b 2.26s   DIRECT 5173384b 2.78s
    seg302  VIA-PROXY 4981624b 3.62s   DIRECT 4981624b 1.95s

~5MB per ~2.1s of video = ~20 Mbit/s sustained. The 2160p rung is simply above
what the line carries. Segments DO need the Referer (403 direct without it).

## ABR tuning (HLS_CONFIG_HYBRID)
`startLevel: -1` + MANIFEST_PARSED fix-up was too late - the first fragment is
already in flight at the top rung. Pinned `startLevel: 0` in config.

First attempt reused the TV profile's `abrBandWidthUpFactor: 0.5` and the
picture never left 360p despite 87s buffered ahead. Settled on 0.8 up / 0.7
down.

## Browser-verified end state
    360p -> 720p at 42s -> 1080p, then stable 42s+
    rs=4 throughout, buffer ~25s, zero stalls
    Server: mapple   Audio language: Telugu (7 available)   dur 9226
    video seg h264 3840x2160 941128b / telugu audio seg aac stereo 118816b

Correctly stops below 2160p.

## Remaining, NOT fixed
The 402s padding is distributed, not one ad block (mapple segments are a
uniform ~2.1s throughout, no outlier at either end). The PTS probe only sees
the encoder baseline - it measured 0.088s. A viewer on this pairing may need
the Audio timing bar; the Audio menu now says so when `padded` is set.

## Test baselines
    api  npm test        -> 118 passed, 0 failed  (was 104; +6 gate, +8 registry)
    web  npx vitest run  -> 51 files, 529 passed, 0 failed

---

# NetMirror: worked from the API, never in the browser

Reported 2026-09-23 with a DevTools capture on movie/1273049: `master.m3u8`
522, `ERR_BLOCKED_BY_ORB` on the media file, "NetMirror is not responding".

## Root cause - same class as the mapple bug
NetMirror returns a raw mp4 whose origin demands a Referer:

    url      https://bcdnxw.hakunaymatata.com/convert-h264/....mp4?sign=...
    headers  {"Referer":"https://videodownloader.site/","User-Agent":"..."}

    no Referer                      HTTP/2 429  text/html 185b
    Referer videodownloader.site    HTTP/2 206  video/mp4
                                    x-oss-cdn-auth: success

A browser CANNOT set Referer on fetch or <video>, so the request went out bare
and Chrome's ORB blocked the 429/text-html response. curl set the header, so
every server-side check passed - which is why this looked like a working
provider.

## Why turning the proxy off caused it
`processStreamsForProxy` already handled this (`.mp4` -> ts-proxy + headers),
but it only ran under `if (config.enableProxy)`. With the flag off, EVERY
header-requiring stream was handed to the browser bare.

Fix: when the policy flag is off, still proxy streams that carry request
headers; everything else stays direct.

    [proxy] 5/6 stream(s) routed via proxy (header-gated origins); the rest direct

## Ordering trap (caught before it shipped)
Both proxy branches strip `headers` once the proxy carries them, so
`streamHeaders.rememberStreams` had to move BEFORE the rewrite (apiServer.js
:586). Recording after would have stored proxied urls with no headers and
re-broken /hybrid/pair. Regression-checked: 1290190 still returns
`{"padded":true,...}` HTTP 200.

## Verified
Server, exactly as the browser asks (no Referer, plain range):

    ts-proxy 206 131072b 0.32s
    Content-Type: video/mp4
    Content-Range: bytes 0-131071/2151656794
    magic: ftypisom

Browser, movie/912649, NetMirror selected:

    1920x800 rs=4, t 544 -> 574 continuous, no error banner
    Server: NetMirror. 12 available
    41 ts-proxy requests, 0 direct hakunaymatata hits, no ORB block

## Test baselines
    api  npm test        -> 118 passed, 0 failed
    web  npx vitest run  -> 51 files, 529 passed, 0 failed

# NetMirror audio: the languages were in the file all along

NetMirror's `/api/embed-tmdb/` path returns bare files — `{url, resolution,
size}`, no language list, no audio array. So a Telugu original was reported as
`languages:[]`, which is worse than it sounds: an unlabelled stream is
invisible to the language-first ranking, so it does not rank *below* a Hindi
dub, it never competes at all.

The tags were never missing. Measured 2026-09-23, `movie/628241`
Ala Vaikunthapurramuloo, NetMirror 720p:

    stream 0  h264  language=eng
    stream 1  aac   language=tel      <- and we were reporting languages:[]

## Why ffprobe over http is affordable
It seeks to the moov atom and reads a few hundred KB — it does not fetch the
film. `lib/media/mp4AudioProbe.js` adds a 30-minute cache keyed on
`hostname+pathname` so a re-resolve, which issues a fresh CDN signature, does
not pay for a second probe.

Header-gated origins answer 429 to a bare request, so the probe passes the
provider's headers as one CRLF-joined blob via ffprobe `-headers`.

## The non-blocking version was a mistake, and was reverted
Probing in the background and serving whatever was cached cut 628241 to 4.0s
and 912649 to 4.3s. It also shipped `languages:[]` on the request the viewer
actually sees — a correctness loss dressed as a speed win.

    User: "blocking is fine, never loose audio or video info"

Only the smallest file of a title is probed, and its tags are applied to every
rung, since the rungs are re-encodes of one source.

`cachedAudioTracks()` survives from that experiment and is currently unused. It
is deliberately kept: it distinguishes `undefined` (never probed) from `[]`
(probed, no audio), which is the distinction any future latency-budgeted caller
needs, and it is covered by tests.

## A deadline nearly re-broke this
A first `PROVIDER_DEADLINE_MS` of 6000ms cut NetMirror off mid-probe and
silently dropped its Telugu tag. Raised to 20000ms after netmirror measured
9226ms cold. The deadline exists to stop one dead provider stalling a resolve,
never to trade away a language.

## Verified
Browser, `movie/628241`, NetMirror selected:

    Server: NetMirror. 8 available
    Audio language: Telugu. 3 available
    1920 wide, rs=4, t 1835.1 -> 1847.1 continuous, banner: null

API, fresh resolve 2026-09-24:

    628241  8 streams, Telugu at ranks 0,1,2, NetMirror 720p ["Telugu"]
    912649  langs=['English'] q=1080p
    579974  Telugu absent - RRR genuinely has no Telugu on any provider

Cold netmirror 7330-9226ms, warm ~0ms (cache hit).

## Test baselines
    api  npm test        -> 133 passed, 0 failed   (118 + 15 mp4AudioProbe)
    web  npx vitest run  -> 51 files, 529 passed, 0 failed

`test/mp4AudioProbe.test.js` drives a fake ffprobe through `FFPROBE_PATH`
(`test/fixtures/fake-ffprobe.js`) — no network, no real mp4, but the real
execFile/JSON/cache path. Mutation-checked: keying the cache on the full url
fails 1, dropping the audio-only filter fails 4, not caching failures fails 1.
