# Pending work

Queue of engineering fixes. One item at a time. Each item: reproduce first, fix the root cause, test, verify on the strongest rung, then tick it.
Source notes: code-read findings from 2026-11-20 unless marked measured. Nothing below is verified at runtime yet.

## Telugu audio over any video (hybrid)

Goal (owner): Castle and NetMirror Telugu audio play over the video of every provider, on web, app and cast.

- [x] **H1. NetMirror audio loses its timing fix.** The web posts an already proxied audio URL, so `buildMaster` treats it as local and drops `rebase=1` (`utils/hybridStream.js:523-524`); the proxy honours `pts` only with `rebase=1` (`proxy/proxyServer.js:621`). Repro: pair a video with NetMirror HLS audio, read the master, check audio URIs for `rebase=1`. Fix: decide from the target URL inside `/m3u8-proxy`, not the prefix.
- [x] **H2. Pair route can swap video and audio.** `/hybrid/pair` picks the top plan by video height (`lib/media/hybridRoutes.js:144`). Repro: pair where the chosen video also lists audio tracks and the donor picture is taller. Fix: keep the viewer's roles.
- [x] **H3. Header refill misses proxied URLs.** `withKnownHeaders` looks up the raw URL (`hybridRoutes.js:113-114`). Works today only because the proxy URL carries headers. Fix: unwrap `/m3u8-proxy?url=` before lookup.
- [x] **H4. Castle single-language files cannot donate.** castle-demux needs 2+ audio tracks (`lib/media/republish.js:262`) and uses only the first Castle row (`:224-227`). Fix: allow 1 track when it is the wanted language; demux every Castle row.
- [x] **H5. NetMirror HLS audio never offered as a pair.** Rows lack `audio[]`/`selectableAudio` (`providers/netmirror.js:648-683`, `streamSchema.js:226-228`), so the audio menu calls them "substitute" (`web/lib/player/trackChoices.js:83-104`). Fix: set both from post.php `lang`.
- Done 2026-11-20: H1-H4 + H5 backend in c656ffa (340/340 tests, 12 new, 7 failed before), H5 web in edf87cd (live on both domains). Live: Castle Telugu-only demux works (Krack audio segment 200). Not live-verified: a full paired master, NetMirror rebase=1.
- [x] **H15. Verify a full paired master live** on a title with an HLS non-Castle video the same length as its Castle/NetMirror Telugu audio (Krack 409 was correct: 6150s vs 9033s).
- [x] **H16. Cost check:** Castle Telugu-only demux now ranks tier 1, so standalone Castle Telugu runs ffmpeg twice per segment (video + audio). Watch VM CPU/memory; consider proxying the raw row when no pairing is requested.
- [ ] **H6. mapple fMP4/HEVC titles pair badly.** Codec probe reads TS H.264 only (`hybridStream.js:167-181`); provider `stream.codecs` ignored; PTS probe fails without the `EXT-X-MAP` init segment. Fix: use `stream.codecs` first; probe init+first segment.
- [ ] **H7. Audio codec always labelled `mp4a.40.2`** (`hybridStream.js:520`). AC-3/EC-3 donors would be mislabelled. Fix: read the donor's `CODECS`.
- [ ] **H8. No decode check.** A pair returns 200 even when the browser cannot decode it. Fix: return codecs; client checks `MediaSource.isTypeSupported` before switching.
- [ ] **H9. Failed PTS rebase serves unshifted segments silently** (`utils/ptsRebase.js:109-113`). Fix: log a greppable line and count it.
- [ ] **H10. NetMirror Netflix mp4 cannot donate** (full-length Telugu for Krack 784572). Fix: audio-only HLS remux route (ffmpeg `-map 0:a -c copy`, time-segmented), same pattern as castle-demux. Watch VM memory (pm2 500MB).
- [ ] **H11. Progressive mp4/mkv video cannot take donor audio** (showsst mp4, zxcstreams mp4, 4khdhub, likely streamflix). Fix: video-side remux to HLS; mkv may need audio transcode.
- [ ] **H12. Measure containers** for hdghartv, videasy, streamflix before deciding H11 scope.
- [x] **H13. Android has no hybrid** DONE 1.2.6 (c6f9f7f): MergingMediaSource [picture, Castle/NetMirror Telugu] from the Audio menu, overrides on "0:"/"1:" groups, no PTS shift (per-source TimestampAdjuster, V126Test); device A/V sync unverified. Was: (`android/.../player/PlayerVm.kt:191-216`). Option A: port `/hybrid/pair` (HLS only). Option B: media3 `MergingMediaSource` (also takes progressive mp4 video, no server remux; needs `TrackSelectionOverride` and offset handling). Ship in an app release after 1.1.8.
- [ ] **H14. Auto pairing off since 2026-09-22** (`apiServer.js:997`). Decide with owner whether to re-enable once H1-H9 land.

## Cast to TV via Web Video Caster (no APK on TV)

Design done 2026-11-20 (scratchpad/wvc/, prototype master validated with ffprobe). Launch: `wvc-x-callback://open?url=…&title=…&poster=…&mime_type=…` or Android intent package `com.instantbits.cast.webvideo`. Hisense VIDAA has a WVC receiver (vidaa.webvideocaster.com): H.264 only, max 1080p, browser engine.

- [x] **C1. Backend `/cast` route** (`lib/media/castRoutes.js`): `POST /cast` {url} or {pair,tmdbId} → id; `GET /cast/:id.m3u8` with TTL = runtime + 1h (hybrid jobs today expire after 20 min, `HYBRID_JOB_TTL_MS`, and die on restart); Telugu-only single audio rendition `DEFAULT=YES`; `POST /cast/playlist` for APK uploads (2 MB cap, 4h TTL, segment-host allowlist). DONE 4938da6 (2026-11-20). Jobs persist to `data/cast-jobs.json` (deploy carries data/), TTL = TMDB runtime + 1h (else measured duration, else 3h), castle-demux jobs a cast points at are snapshotted and kept alive past their 30 min and across restarts. Live: Devara pair cast 200, TTL 238 min.
- [x] **C2. Cast hybrids must be audio-only rendition + video-only variant.** Measured: muxed renditions carry both tracks, so a receiver that ignores the audio group plays Tamil. Use castle-demux `audio-N.m3u8` / `video.m3u8`. Add `castSingleAudio` option to `buildMaster`. DONE 4938da6. `buildMaster(..., {castSingleAudio})`; remote audio renditions are probed and refused (409) if they carry video; a muxed video (OneTouchTV) is split per segment by ffmpeg `-map 0:v -c copy` at `/cast/:id/v/:n.ts`. Live ffprobe of the Devara cast master: 1 audio stream `language=tel` + 1 h264.
- [x] **C3. Web Cast button** (phone only, not TV): `web/lib/cast.js`, PlayerControls, Player, detail page "Cast to TV". DONE 4938da6 (player controls only; detail page is C3a). Two taps: Cast prepares, then "Open Web Video Caster" link. Headless 412px Android: intent link to `com.instantbits.cast.webvideo`, desktop shows no button. Real TV playback unverified (C8).
- [x] **C4. APK "Cast to TV (WVC)" action** with `HTTP_HEADERS` bundle; mapple/vaplayer after on-device resolve. Measured: vaplayer master without Referer/Origin = 403 even from the token's /24, and TV browsers cannot send Referer, so these two need routing through the phone (WVC setting) or **C5**. DONE 2026-11-20 in android 1.2.0 (code 13): phone-only cast button in player top bar, `player/WvcCast.kt`, `WvcCastTest` (8 tests). Extras per webvideocaster.com/integrations: `title`, `poster`, headers Bundle `android.media.intent.extra.HTTP_HEADERS`; no position extra documented, so TV starts at 0. Unverified on the TV. Open risk: vaplayer segments need `?token=` appended (StreamInterceptor); WVC will not add it, so vaplayer likely fails even with phone routing, which points at C5.
- [x] **C5. LAN proxy in the APK** DONE 1.2.5 (01e804f): LanProxy on the Wi-Fi IP, rewritten playlists, headers + ?token= + Castle swap upstream, mediaPlayback FGS, idle 15 min stop; loopback test green, real TV playback unverified. Was: (fallback if WVC phone-routing fails or is premium): phone serves the stream with headers + token on the LAN.
- [ ] **C6. One VM curl:** does the mapple video CDN accept the VM with Referer (only mapple.fun API is known blocked)? If yes, mapple becomes castable from the website through `/m3u8-proxy`.
- [ ] **C7. Shorten proxied URLs:** ~900 B headers JSON per playlist line; some DLNA/Roku players may reject long URLs. Header-profile key instead.
- [ ] **C8. Device matrix test:** Hisense VIDAA, Android/Fire TV, Chromecast × plain HLS, hybrid master (does Telugu play), APK headers via phone. Also check VIDAA receiver accepts https.
- [ ] **C3a. Detail page "Cast to TV" button** (web/app/title/**): skipped in 4938da6 because another agent was editing that page. Reuse `web/lib/cast.js` (`canCast`, `castBody`, `prepareCast`); it needs a chosen source, so it likely opens the player first.
- [ ] **C9. Plain-url cast of a muxed source has no language guarantee.** `POST /cast {url}` on a raw Castle TS row (all languages muxed) or OneTouchTV (one unlabelled AAC) serves the stream as is: the receiver plays the first audio track. The player already prefers the castle-demux row on Devara; make the Cast button pick the demux row or a pair when the playing row is muxed.
- [ ] **C10. VIDAA limits on the cast variant:** the pair cast takes the tallest variant (describeStream). VIDAA's WVC receiver is H.264 only, max 1080p. Pick the tallest H.264 rung at or under 1080p for casts.
- [ ] **C11. `/cast/playlist` host allowlist** defaults to our own host only; `CAST_PLAYLIST_HOSTS` (comma list, suffix match) must be set before the APK uploads playlists (C4/C5). Owner decision on which hosts.
- [ ] **C12. Cast life is bounded by upstream signatures:** OneTouchTV segments on Devara carried `hdntl exp=1795217438` (23:30:38Z, about 5.7h after resolve). A cast made from a stale listing can 403 mid-film. Measure Castle's `?t=` lifetime; consider re-resolve on 403. Also: a cast created in the seconds between deploy stage copy and swap is not carried over.
- [ ] **C13. One-tap cast on a real phone:** the web uses two taps because Chrome may block an intent navigation that follows an await. Check on a real Android phone whether one tap works when POST /cast is fast (plain url ~0.2s, pair ~0.75s measured).

## New providers from the community (research 2026-11-20, nothing tested)

Best fit: Nuvio local-scraper JS repos (TMDB id in → `{name,title,url,quality,headers}` out; port = `.then` chains to CommonJS). Our 13 checked providers all exist there.

- [ ] **P1. Refresh existing providers from fresher Nuvio copies:** SA7ANI/cb-providers (castle, netmirror, 4khdhub, dahmermovies, moviebox; 2026-11-15) and D3adlyRocket/All-in-One-Nuvio (mapple, hdghartv, videasy, vidlink). Diff against ours; may revive the four that failed upstream.
- [ ] **P2. Telugu-tagged sources first:** einthusan (te/ta/ml/kn/hi, SA7ANI), mallumv / movieblast / allmovieland / zinkmovies / peachify (D3adlyRocket, yoruix/nuvio-providers), multimovies (mayurgj/nama), Moviezwap (`te`, NivinCNC CloudStream — compiled only, needs a JS equivalent or reverse-engineering), Fivemovierulz (phisher98, compiled only).
- [ ] **P3. TMDB-keyed embed APIs, best VM candidates:** vidrock, vidfast, vidzee, vidsrc, xpass (D3adlyRocket, SaurabhKaperwan/CSX ProviderRegistry.kt).
- [ ] **P4. For each new provider:** ONE live call from the VM and ONE from a residential device. VM-blocked ones go to the APK on-device path. Record language tags (Telugu-first) and container (HLS vs mp4, for hybrid H11).
- [ ] **P5. Host resolvers:** port fixes from Gujal00/ResolveURL (filemoon, streamtape, mixdrop) when a provider returns a host page.
- Live test 2026-11-20 (scratchpad/nuvio/, 14 scrapers, Krack 784572 + Inception 27205): **multimovies** (mayurgj/nama) WORKS, Telugu multi-audio HLS (TAM/TEL/MAL/KAN), full chain 2xx on Mac, hosts 200 from VM. **vidrock** works, English only, hosts 200 from VM. Dead: einthusan (CDN 404), streamflix (mkv 404), movieblast, peachify, zinkmovies, vidfast, vidsrc, xpass, hdghartv, videasy (seed 404). Untested (Mac ISP blocks): allmovieland, mallumv. Not found: vidzee, zxcstreams, Moviezwap, Fivemovierulz. Note: this Mac's DNS sinkholes api.themoviedb.org (use api.tmdb.org).
- [x] **P6. Port multimovies**: live in 75b128e (VidBolt only). Krack lists Telugu but audio track playlists hang (proxy 500 after 30.2s), so the row can't play.
- [x] **P6a. multimovies audio check** (done 14ab70a, 2026-11-20: retest once still hung kan/mal/tam at 30s, tel 593ms; now one parallel GET per rendition, no 2xx in 8s = dropped, `[multimovies] audio rendition X dropped`. Prod Krack: 9.4s, 1 row, audio [Telugu]. Master served to the player still declares the dead tracks: proxy filter not done): probe the Telugu track playlist before listing the row (blocking fetch, owner call), or let auto-advance skip it. Retest Krack once later: the host may have been slowing our requests.
- [x] **P6b. multimovies image-segment check** (done 14ab70a: background, cached per host 6h; prod log `segment check host=img.rousav.tech disguised=false` after the resolve returned): times out at 5s on Krack and adds about 5s per resolve.
- [x] **P7. Port vidrock**: live in 75b128e. English only; 0 rows on Krack.
- [x] **P7b. vidrock segment URLs look single-use** (NOT reproduced 2026-11-20, one resolve: first segment 200 x4, two sequential + two parallel, 400520b each. vpts=null likely the sporadic vercetti 403, see P7a. No change): hybrid codec+PTS probes fetch the first segment in parallel; live pair got vpts=null, ptsOffset=0. Unverified.
- [x] **P7a. vidrock master expires in about 60s** (misdiagnosed 2026-11-20: same URL across resolves 3 min apart; 403 is sporadic at any age, 1/10 at 3s spacing, laptop 403 at t=20s then 200 at 40/60/80s. TTL cap would re-resolve to the same URL, so none added. Fix 14ab70a: one retry on master 403 at resolve; prod hit it at 18:05:53 and kept the row. Prod cached URL 200 at 73s. Proxy-side playlist/segment 403s not retried) (200 at 30s, 403 at 60s). URL has no expiry field, so lib/urlExpiry can't see it. Fix: per-provider stream-cache TTL under 60s, or re-resolve on 403.
- [ ] **P8. Test allmovieland + mallumv from the VM** (sites answer 301 there).
- Ruled out: Consumet (GitHub 451), p-stream/providers (archived), webstreamr (archived), MediaFusion (torrent/debrid), recloudstream/extensions (no Indian providers). anonvibes/TFI is catalog-only (could feed Telugu title lists).

## NetMirror languages (audit 2026-11-20, scratchpad/netmirror/notes.md)
- [x] **N1. VM gets "page not found" from every Prime/Hotstar search** (24/24, 16:18-17:25 UTC); the Mac gets JSON. readNewTvJson (netmirror.js:579) treats it as no rows, so no base rediscovery and a 90s empty cache.
- [x] **N2. One labelled mp4 cancels all other catalogues** (netmirror.js:1012-1013). Kalki: Prime has 4 languages, we return 1.
- [x] **N3. Netflix HLS catalogue never resolved for streams** (netmirror.js:1015-1017).
- [x] **N4. `disney` duplicates `hs`** (netmirror.js:21,140): 1 wasted request per title.
  - Done 1dd8a09 (deployed 17:39Z). N1 cause: IP block. One identical script, base https://tv.imgcdn.kim both sides, same headers, no cookie: VM 403 text/html Page Not Found, Mac 200 JSON. Not worked around (owner rule: device resolves it). Code now counts it as a failure (rediscovery after 2), never "no rows". Device call list: scratchpad/netmirror/ondevice.md. N2-N4 code done; on the VM Prime/Hotstar stay blocked, so their gain shows only from a residential IP.
  - 52d11c8: a memoised refusal no longer counts twice. Mac lookup 17:45Z: player.php answers status "otp" and serves the 220884 clip for nf and pv, so no HLS row even from a residential IP (see ondevice.md). Open.
- [ ] **N7. Throttle-aware NetMirror** (owner 2026-11-20): cool-down 10m doubling to 2h on clip/otp/429, reset on a real master; newtv 6h block on 403 Page Not Found; 6 newtv calls per 5 min bucket (embed exempt); search/post 7d, player until expiry, rows until url expiry; all persisted in data/netmirror-state.json (utils/netmirrorGuard.js). Device feed design: scratchpad/netmirror/device-feed.md.
  - Done c101feb, deployed 17:59:33Z (npm test 392/392). Live: first post-deploy lookup of 811941 (a viewer, 17:59:53) sent 1 checknewtv + 1 refused search, then newtv-block 6h, Prime/Hotstar skipped. My calls 18:00:00, 18:00:27 (refresh=1), 18:00:41 (refresh=1), 18:02:06 (refresh=1, 85s later): 0 NetMirror requests, same 1 row from the NetMirror cache. Open: device feed (design only); cached language list is not yet returned during a throttle (needs an apiServer field); embed mirror walk restarts from net27 after each restart (3 failed connects).
- [ ] **N5. Castle gate skips NetMirror in /api/streams when Castle has Telugu** (apiServer.js:883-905). Measure after N1-N3.

## Parity APK vs web (audit 2026-11-20, scratchpad/parity/parity.md)
Start APK items after C4 (1.2.0) lands; web player items after C3 lands.
- [x] **U1 (P0). APK subtitles empty**: no OpenSubtitles fetch (web: web/lib/subtitles.js). Port it.
- [x] **U2. APK source order**: sorts by height within a language tier (Ranking.kt:99); web keeps learned server order (backend.js:267-270).
- [x] **U3. Server menu order differs**: web menu by height (trackChoices.js:44-65), APK by rank. Labels like "CastleTV 2" differ.
- [x] **U4. APK never sends /api/playback-report**: APK plays don't train ranking.
- [x] **U5. APK has no runtime check** (web: under 82% fails over, runtimeCheck.js:8).
- [x] **U6. APK dead-source wait 25s** vs web 8s/20s (PlayerVm.kt:532 vs switchFlow.js:31-32).
- [x] **U7. APK auto-advance ignores language; manual switch clears tried** (PlayerVm.kt:312-323, 500-503).
- [x] **U8. APK no offline handling**: fails through every source.
  - U1-U8 done in android 1.2.1 (881cb7c, 87 unit tests green). On-device check pending: phone was in use at build time, not installed.
- [x] **U9. Web phone player: Server/Audio/Quality hidden in Settings**; buttons 38px (APK 48dp).
  - Done f3ca49c, deployed chtrm-kmn8l2hyt (chtrm2 + chtrm aliased). Phone row: Server and Audio in the bar (one tap to the Audio list), Quality stays in Settings; 38px look with a 44px hit area (::after inset -3px); Mute hides under 400px so the row fits 360 (Fullscreen right edge 340 of 360). Labels Server/Audio/Quality/Subtitles.
- [x] **LX. Web loading screen (loading-ux spec, web half)**: web/lib/player/loadingModel.js mirrors LoadingModel.kt; no Try again at 8s (15s hint, 30s Try again with no list via load(false), 30s Choose a server with a list); Details rows per source; one stable label map (CastleTV 3/4 mismatch); onMore keeps row ids; toast no longer clipped at 412.
  - Done f3ca49c, deployed chtrm-kmn8l2hyt. Live (phone, /api/streams held 45s): Try again absent at 8.0s and 29.0s, present 31.0s; Try again sent 0 new /api/streams requests. Unverified: real first-frame timings and post-frame toasts (headless has no H.264). Not done: the end card keeps its old layout (only copy changed); search-phase Details does not list per-provider timings after the answer (the list replaces it).
- [x] **U10. Web TV 8px horizontal scroll** (rail arrow icon, globals.css:628,1671); Tab focus escapes the open player.
- [x] **U11. Web small fixes**: desktop search shows two clear buttons; early keystrokes lost on search (unverified); small phone tap targets; label wording differs across surfaces.
  - U10-U11 done in 2d9a941, deployed chtrm-mb3po0n2w (chtrm2 + chtrm aliased). Prod: TV scrollWidth 1280/1280; Tab 0/25 out of the player; Devara kept with JS held 2.5s; hit areas dots 35x40, See all 52x42, season chips 40 (38 by pixel probe); labels Server/Audio/Quality/Subtitles.

- [ ] **N6. Radhe Shyam 673392 has no Telugu** (RCA 2026-11-20, scratchpad/radhe/): every row is Hindi/Tamil/Malayalam by Whisper language check. Only hope: NetMirror Prime (N1) or mapple (VM breaker; APK device resolve). Verify after N1.
- [x] **L1. vidrock trusts the server's language field** (done 14ab70a: stated language labels the row only when a master AUDIO rendition confirms it; else 'und', hint kept on raw row `statedLanguage` and in the log. Segment probe cannot confirm: Nova TS has no language tag. normaliseStream drops statedLanguage from the API output) (providers/vidrock.js:76-77): Radhe Shyam Hindi is labelled English. Owner call: probe instead or leave unlabelled.
- [ ] **L2. Unlabelled single-audio rows** (onetouchtv, showsst, netmirror mp4, multimovies VidBolt with no AUDIO renditions) are invisible to Telugu-first ranking. Consider spoken-language detection (Whisper small on a 30s clip) as a cached background tag per file; Whisper confuses te/ml, so use forced-language log-probs.

## Cooperative APK (plan 2026-11-20, scratchpad/selfcontained/plan.md) — awaiting owner go; start after 1.2.1
- [x] **K1. Phase 1** (APK 1.2.3, c93c917, 2026-11-20; 19 tests in V123Test incl. VM refused → device rows <3s; live: Castle Mirai muxed 5 langs, segment PIDs hin 257/tel 259 → swap plan (257,259); MultiMovies 1222479 7 langs 1080p in 4.0s. Unverified on phone: not installed, focus was NotificationShade. Gap: device Castle needs the Castle spelling; cinemeta 'Mirayi' misses 'Mirai' until Phase 3 TMDB title): VM breaker (2 fails → 60s, doubling to 10 min, cached); direct VM origin with 3s connect / 22s streams timeout (today 120s read + 2 retries); device rows never wait on VM; Castle + MultiMovies resolved on device; Castle Telugu via TS PID swap DataSource (port web/lib/player/tsAudio.js); VM row fails → device re-resolve at same position.
- [ ] **K2. Domain book per provider** with signed host-pattern allowlist; refresh VM → signed GitHub/Vercel static → cache → built-in.
- [ ] **K3. POST /api/host-report** feeding upstreamBase rediscover; deviceOnly list for mapple/vaplayer (2 installs).
- [ ] **K4. Device fallbacks for the other providers + TMDB direct metadata (api.tmdb.org)**; hybrid via MergingMediaSource (= H13).

- [ ] **K5. NetMirror newtv on the device** (app flow: call newtv/otp.php, carry its token/cookie into search/post/player; host mobidetect.cc seen) (VM IP-blocked: Cloudflare 403 'Page Not Found'; calls in scratchpad/netmirror/ondevice.md). First solve player.php `"status":"otp"` (seen from the Mac after ~7 newtv calls; token or throttle unknown). Test on the phone's own IP, one call, not the Mac.

- [x] **A8. APK 1.2.1 played Mirayi 1222479 on CastleTV · Hindi** (phone 23:23, screenshot scratchpad/dev/home.png). Telugu film; check whether a Telugu row existed and why ranking picked Hindi (resume position 11:07 may have pinned the last source). DONE in 1.2.2 (95f117e): pill fell back to languages.first()=Hindi before tracks loaded and pickPreferredAudio skipped backend rows; pin now auto unless picked by hand, auto pin stays inside the preferred language. Real audio on the phone unverified.

- [x] **A9. APK must follow a partial /api/streams with ?full=1** (RCA scratchpad/vmrows): VM returns partial:true (PRIMARY_PROVIDERS set) with only ready rows; web re-asks (web/lib/backend.js:398), APK never does (Api.kt:237, partial parsed in Models.kt:117 but unread). Fix: on partial or non-empty providerErrors, one ?full=1 call (60s), merge + re-rank. (AGENTS.md:348 wrongly says PRIMARY_PROVIDERS unset.) DONE in 1.2.4 (9e9812c, 2026-11-21): Api.streamsFull (60s, null on any failure, breaker untouched), StreamsResponse.wantsFull, Ranking.mergeMore (dedupe provider+url, new ids, one re-rank), PlayerVm.followFull after the first list or a late VM join. Tests V124Test (11 unit). Live one call each 00:11 IST: 1222479 first 1.7s partial=true 3 CastleTV rows, full=1 7.9s 8 rows, merged 8. Phone unverified: not installed, focus was Gmail.
- [x] **A10. Castle on-device title match: TMDB "Mirayi", Castle "Mirai"** DONE in 1.2.4 (9e9812c): live "Mirayi 2025" gave 30 unrelated rows and the loop stopped there; now each spelling is tried until a row matches. TitleMatch.find adds original_title (alternates), compact (no spaces/punct) and Telugu-fold (Vyi→Vi, doubled vowels) passes, year guard ±1 for films (Castle publishTime). Negatives tested: Mirai 2010, Mira, Maya/Ma, Kalki part 1/2. Live: CastleResolver("Mirayi", 2025) resolved in 1.5s, Telugu first. original_title: /api/title/.../full does not send it today (field read if present). MultiMovies resolves by TMDB id, no title match needed.

## In flight (2026-11-20)

- ts-proxy no-Range progressive bound + `seg=1` LIVE as 0e6823d (2026-11-20 16:56Z). Baseline: pm2 restarts 29, 6 memory restarts that day, last 16:27:20Z at 968658944 B. **Recheck after real viewing:** `pm2 jlist` restart count + grep `~/.pm2/pm2.log` "exceeds" since 16:56:09Z. Open risk: the progressive window still grows 4MB per fully-read window up to 256MB per response.
- Switch redesign (web): overlay, warm next 2-3 sources, `?full=1` on provider errors, timeout auto-advance. Spec: memory `chitram-switch-redesign-spec`.
- APK 1.1.8 BUILT 2026-11-20 (not installed, not committed): android/app/build/outputs/apk/release/app-release.apk, versionCode 11, same cert 54d3b357…e6ed0ee3. On-device mapple + vaplayer (MiniWasm interpreter, no new dependency), 62/62 unit tests. Live mapple from Mac: 1 of 2 attempts passed (first timed out at 8.2s, cause unknown).
- [x] **A1. Backend `GET /api/resolve-config`** so the app's resolvers heal without an update (JSON shape in the APK agent report; app uses built-in defaults on 404). DONE 4938da6: `routes/resolve-config.json` (app defaults exactly; test compares against ResolveConfig.kt), `Cache-Control: public, max-age=300`, Vercel rewrite so chtrm2/chtrm serve it. Live 200 on API, chtrm2, chtrm.
- [ ] **A2. Device test of 1.1.8:** mapple and vaplayer play on phone and Fire TV; vaplayer on mobile data (CGNAT /24 risk).
- [ ] **A3. mapple s12 timing:** stream-encrypted took 3.5s against a 5s front limit.

## Other open

- Detail-page skeleton flicker (diagnosed, not built): reserve episodes/facts space, one backdrop element across skeleton and page, pin hero text and reserve overview height, drop staggered `.enter`.
- Verify Krack 784572 Telugu fixes (e3ff120) on a real play-through.
- streamflix, hdghartv, videasy, zxcstreams: all failed upstream from a residential Mac on 2026-11-20. Flags reverted to false.
- Install APK on phone when adb reconnects.

## From the phone test of 1.1.8 (2026-11-20)

- Live check 2026-11-20 17:16Z: memory fix OK (0 memory restarts after 16:27:20Z; 3 deploy restarts only; short soak). H15 OK: Devara 811941 OneTouchTV video + Castle Telugu audio paired, delta 0.083s, master + segments 200. H16 OK: castle-demux segment 0.06s audio / 0.13s video incl. ffmpeg, load <1.
- [ ] **A4a. Vercel function region:** /api/title/:type/:id/full runs in iad1 behind a bom1 edge and never caches (x-vercel-cache MISS despite revalidate=604800). Move functions to bom1 and make the route cacheable. Route ~0.45-0.55s, so this is NOT the 20s.
- [ ] **A4. Title page takes ~20s** on the phone (Salaar): route itself answers in ~0.5s, so the 20s is in the app. Hypothesis: home Jio DNS sinkholes api.themoviedb.org (measured on this Mac: 12s timeout), so any direct TMDB call from the phone stalls. Check the app's hosts with logcat.
- [ ] **A5. 1.1.9: drop the 3s on-device grace wait when the backend already has a Telugu row** (agent proposal, awaiting owner go). Measured: Resume to first frame 6.0-6.8s.
- [ ] **A6. mapple front s25 playlist has no audio list**, so its Telugu track has no language and ranks low. Probe audio on device (or read track NAMEs from the media playlist) so the label is not lost.
- [ ] **A7. mapple front skip is 10 min after one failure;** a slow s12 answer can hide mapple for a whole session. Retry once before skipping.
- Phone result: mapple (s25) and vaplayer both played on home Wi-Fi; vaplayer token OK, no 403. Mobile data untested.
- [x] **A11. mapple Telugu-first front choice (Kubera 1171101)** DONE 1.2.7 (bb25440, 2026-11-21): a language-less front hit no longer wins at betterWaitMs 2500; it waits while fronts run, up to max(betterWaitMs, betterWaitMaxMs=12000, config-overridable, clamp 0..30000), or until all fronts settle. Hindi-only "mapple" front (TS, no SPS/PPS, media3 crash) won before s12 (Telugu, 9th of 13) started. KEY_FRONT now stores only a preferred-language front. V127Test reproduces the race (fails on the old policy). APK ~/Documents/Projects/local/chitram-android/Chitram-1.2.7.apk built from c6f9f7f + fix (no NetMirror), installed 00:45 IST. Kubera on the phone unverified. SPS/PPS injection not done (not needed if s12 wins).

## NetMirror authenticated device path (2026-11-21)
- [x] Implement TV OTP session lifecycle in backend (opt-in `NETMIRROR_OTP`) and Android (owner-supplied `111111`, local override), all catalog/episode/player paths.
- [x] Preserve device catalog/dub rows, audio languages and embedded HLS subtitles; retain completed rows on timeout and refresh all rows on playback recovery.
- [x] Trace mobile cookie/hash flow and native browser handoff: server-issued challenge, no Chrome cookie import; completion not observed. See `docs/netmirror/README.md`.
- [ ] Verify real title/season, playback, audio switching and token renewal on Xperia; device was not connected during implementation.
- [ ] Configure `NETMIRROR_OTP` in the deployed backend if backend authentication is desired; existing VM IP refusal/budgets remain effective. No deployment performed.

- [x] Website NetMirror locally enabled and browser playback verified (2026-11-21): live Telugu HLS rendered; MP4+HLS rows retained with stable source IDs. Web893/backend416tests passed.
- [ ] Deploy website/backend NetMirror changes to the live environment and configure server OTP; live VM IP-refusal and multi-language playback remain unverified.

## NetMirror playback parity (2026-11-21)
- [x] Dynamic catalog discovery, all matching dubs/qualities, actual audio vs catalog labels, proper season labels/IDs and episode cursors, partial-source continuation across website/API and Android. See `docs/netmirror/PARITY.md`.
- [x] Fix rich-only website title enrichment retaining season selector; live five-season selector and S2E1 request exercised.
- [x] Hardware APK1.2.8: NetMirror S2E1 playback, Telugu selected and in-stream Tamil selection; Auto/1080p/720p menu observed.
- [ ] Finish live browser multi-audio/quality/caption checks and hardware caption rendering; keep service budgets and pending metadata explicit.

## Player modal consistency — 2026-11-21

Shared website picker headers, close/Escape handling, selected rows and responsive phone/landscape/TV surfaces. Existing settings sheet retains picture and subtitle controls. Android uses consistent rows, viewport-capped side panels, selected-row scrolling and a portrait bottom sheet. Player transport, seek bar and below-player layout are preserved. APK 1.2.9 (22) built and installed on OnePlus CPH2447. Device playback and visual TV verification remain separate from build/unit verification.

### Player modal follow-up — 2026-11-21

APK 1.2.12 (25) corrects the phone landscape panel and routes the loading chooser into the same modal. Server navigation is a compact provider list followed by all streams for that provider. Netflix, Prime Video and Hotstar are stream metadata labels, without an extra catalog screen; legacy unidentified catalogs stay unidentified. Every list row is selectable. Catalog identity survives backend/web/device adapters. Audio discovery retains both server-to-language and language-to-all-servers mappings, including later results and observed tracks. Explicit language retries stay within confirmed candidates; generic numbered tracks remain unknown. Website and APK restore previous playback when a language trial exhausts its candidates. Catalog checks reuse existing resolvers; this does not implement a new browser-direct provider transport.

One Peddi device attempt: CastleTV returned no video, Mapple s12 was busy and fallback had no audio metadata; later MultiMovies Telugu rows joined. This is not proof that every listed origin is currently playable.

NetMirror timeout follow-up: after a no-answer timeout, an explicit re-resolve that returns the identical URL/headers/token advances to the next candidate instead of spending another attach timeout on that same CDN target. Renewed URLs remain eligible. This removes a duplicate wait; it does not claim the failing upstream CDN is repaired.

- [x] **Player sheets: dead taps + compact redesign** (APK 1.2.13 (26) + web). A1/W2: a language pick never resolves to the playing source when its tracks lack that language (next server or "No other <Language> stream found"); A2: re-tap on a selected row closes; A3: unsupported subtitle tracks hidden; W1: web sheet idle 10s, none on touch; W3 notice on a server with no stream; W5 unique server keys; portrait picker icon centred. Compact rows, "In this stream"/"Other servers" audio groups. V128Test, sheetIdle.test.jsx. On-device tap check unverified.
- [x] **Player sheets: compact content width + NetMirror check feedback** (APK 1.2.14 (27)). Phone side panel sizes to its widest row (200-360dp), scrolling Column, 40dp rows, cutout inset on the panel side only; loading "Sources" panel capped, no empty band; "1 stream"; Check row shows "No NetMirror streams for this title" / "N added" / "NetMirror unavailable"; selected-row focus TV-only (dead scroll); sheet BackHandler + `[back]` / `[netmirror] check:` logs. V129Test. Device scroll/back check unverified.
- [x] **Web: hero dots + rotate, compact player menus, subtitle cp1250 + Small** (3a79af3, 82a11cb; deployed chtrm-ggubvzm2i, chtrm + chtrm2 aliased). Active dot no longer a 34x40 blob (longhands; clip padding-box live); tap on a dot keeps auto-advance (prod: index 3 -> 4 in 9s, focus held, not :focus-visible); Server/Audio/Quality/Subtitles menus content-sized 200-300px, 38px rows, normal-case head (prod portrait rows 38, head 38; desktop mock 222px); phone landscape is a bottom-right card, TV rail unchanged. cp1250 mojibake repaired (Raja: 409 -> 0, byte-identical to original); Small 0.62 -> 0.5. heroRotate/subSizes/mojibake tests. Landscape coarse-pointer render unverified (no device emulation).

## Speed, cache and labels: 2026-11-22 (owner: "we must not miss any of these")
Source reports: .superpowers/sdd/2026-11-22-ux-pass/. One item at a time to done; each closes with device or HTTP evidence.

- [ ] **P1 Prewarm never fires** (1.2.48 phone): a saved config without `prewarm` reads as off. Fix: a missing flag uses the built-in default. In progress (fast-second-play).
- [ ] **P2 Reopen a title**: re-prewarm on reopen; a failed details page retries on reopen. In progress.
- [ ] **P3 Playlist cache**: keep master/video/audio playlists with cached rows (RRR second Play 4.7 s, ~2 s of it playlists). In progress. Web: pLoader cache built, real hls.js test 3 → 0 playlist requests on second Play (unit, not browser). See .superpowers/sdd/2026-11-22-ux-pass/web-parity.md.
- [ ] **P4 Parallel video+audio playlists.** In progress. Web: hls.js 1.7.1 already parallel (real-hls.js test, both in flight); no change. See .superpowers/sdd/2026-11-22-ux-pass/web-parity.md.
- [ ] **P5 First frame at ≤720p, then adapt up** (first 1080p segment 2.4 MB / 1.9 s). Audio choice unchanged. In progress. Web: already starts on the cheapest rung; regression test added, no code change. See .superpowers/sdd/2026-11-22-ux-pass/web-parity.md.
- [ ] **P6 Direct-link stall 10 s → ~4 s** before proxy fallback (Krack 15.9 s). In progress. Web: 4 s no-bytes → proxy added (was 10 s first-frame cap); unit tests only. See .superpowers/sdd/2026-11-22-ux-pass/web-parity.md.
- [ ] **P7 Log label**: `[race] cache hit:` separate from `continuing prewarm:`. In progress.
- [ ] **P8 Remember last played provider** per title, every client; start on it first (language still wins). APK in progress; web after. Web: built (≥10 s played, 300 titles, language tier wins), unit tests only. See .superpowers/sdd/2026-11-22-ux-pass/web-parity.md.
- [ ] **P9 Telugu mislabel**: MultiMovies/Vidrift first "Telugu" row plays Tamil/original. Telugu only on explicit evidence; original stays original/unknown; one explicit Telugu row means the others are not Telugu. Server + APK + web. In progress.
- [ ] **P10 Refresh sources + journey** (APK 1.2.49 + web). Built, 578/1211 tests; not shipped or device-checked.
- [ ] **P11 VM cache 10 → 30 min, capped by URL expiry; parse Castle `Expires=`** (apiServer.js, lib/urlExpiry.js). Local, 793 pass; deploy with P9. APK UrlExpiry: also read `Expires` case-insensitively.
- [x] **P12 NetMirror token reuse**: keep until `status:"otp"`; 24 h safety cap; reuse the token after a base change; log token age on rejection (poc-token-web-clientside.md). Built, unit-tested, device unverified (netmirror-dwell.md). Served `sessionTtlMs` is still 1800000 in routes/ and web/public resolve-config.json: set 86400000 there for the 24 h cap to apply.
- [ ] **P13 Prewarm dwell**: start prewarm after ~1.5 s on details (TV: Play focus) to cut data/NetMirror use on browse. Web: 1.5 s dwell or Play hover/focus, cancel on leave; component test. See .superpowers/sdd/2026-11-22-ux-pass/web-parity.md. APK: built, unit-tested, device unverified (netmirror-dwell.md). Web part open.
- [ ] **P14 Web prewarm**: OneTouchTV client-side; Castle after one browser getVideo2 check. Existing web VM prewarm call kept unless the owner says otherwise (open question). Web: OneTouchTV prewarm built. Castle getVideo2 preflight PASSED from chtrm2 (Chrome, 1 POST, 200 readable); Castle client resolver not built yet. See .superpowers/sdd/2026-11-22-ux-pass/web-parity.md.
- [ ] **P15 Web 30-min client cache + last-provider** to match the APK. Web: built (memory+localStorage, URL expiry, 50 titles, drop on fail, Refresh clears); unit tests; no browser run. See .superpowers/sdd/2026-11-22-ux-pass/web-parity.md.
- [ ] **P16 Phone logs**: this phone drops the `Chitram` tag until `setprop log.tag.Chitram VERBOSE`; capture to a file (the ring buffer is tiny).
- [ ] **P17 Link lifetime check** at 1 h and 2 h for vidrift/multimovies/castle; raise the 30 min cap only on evidence.
- [ ] **P18 Ship + verify**: build 1.2.49, cert, phone install, RRR/Krack cold + warm + restart vs 1.2.46 (8.8 s / 9.7 s); TV install + venezia broadcast when reachable; VM deploy; web deploy + alias; commit/push.
- [ ] **P19 Scenario matrix**: real-use scenarios per fix (network, time, app life, content, user, labels, TV, web, shared VM cache) mapped to code + tests in .superpowers/sdd/2026-11-22-ux-pass/scenario-matrix.md; every high/med gap gets a test (and a fix if the logic is wrong) before P18 ships. 2026-11-22: every HIGH and MED gap plus B1-B5 closed with tests that failed first (gap-fix.md); APK 639/0, web 1267/0, server 812/0. 14.4 owner decision and most LOW gaps remain.
- [ ] **P20 Web Castle client resolver**: getVideo2 CORS passed from chtrm2 in Chrome (200, 476 ms); needs a browser port of providers/castletv.js + Telugu muxed audio. Not built.
- [ ] **P21 MultiMovies bridge 429 (live)**: dash-hls-bridge workers.dev returns 429 from the laptop AND the VM (2026-11-22 14:18Z), so most MultiMovies resolves return 0 rows. Options: APK plays the sacdn DASH MPD directly (media3 DASH); the VM converts DASH→HLS itself; web uses the VM route. Investigate and fix after the gap-fix agent.
- [ ] **P22 MultiMovies MPD lang rule** (built, server 812/812, APK MultiMovies 38/38): Telugu only when the MPD audio lang is `tel`; hidden `tel` sources become Telugu; fallback last-wins. Deploy with P18.
- [ ] Open (parked): phone posters w500 vs w342; home first card after hydration; duplicate images on nav; TV Search Up key; canary still probes vaplayer; mapple CODECS check; persona/profile question for the owner.
