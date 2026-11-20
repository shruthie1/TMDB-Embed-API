# NetMirror APK playback contract audit

Static audit, 2026-11-21. No external requests or provider sweeps were made. These are wired app-code facts from the decompiled APKs, not inferred framework capabilities. A source-level contract does not establish live service acceptance or actual audible-language parity.

Artifacts:
- `/tmp/netmirror-analysis/tv.js` and `tv.hasm` (Hermes version 96).
- `/tmp/netmirror-analysis/netmirror-decompiled.js` and `netmirror.hasm` (phone wrapper).
- Chitram `/Users/SaiKumar.Shetty/Documents/Projects/TMDB-Embed-API` read-only comparison.

## Most important conclusion

**`post.lang` is an availability display, not a language-switch endpoint.** DetailsScreen renders its language strip from `post.lang`, with `item.l` as label/key, but does not wire an `onPress` to those language chips. There is no `Lang` header or `post.lang[].s` -> player request wired in the inspected app.

Actual playback audio, quality and subtitles are selected through the native player's tracks. `player.video_link` is passed unchanged to react-native-video, whose `onLoad` discovers `audioTracks`, `textTracks`, and `videoTracks`. Track selectors use `{type:'index',value:<selected index>}`. Replicating a hidden language API would be inventing a contract.

## Contract matrix and exact evidence

| Surface | Wired APK behavior | Evidence |
|---|---|---|
| Bootstrap | `checknewtv.php` returns Base64 `token_hash`; decode and store as `apiUrl` | function #8649, `tv.js:326590` onward; `tv.hasm:349249` onward |
| OTP | GET `{apiUrl}/newtv/otp.php`, `Otp` header; on status `ok` save `usertoken`, then Home | #9234 `tv.js:347420–347540` |
| Expired/missing user token | Detail/main/player `status:'otp'` replaces current screen with `Otp` | #8867 `tv.js:334772–334911`; #8957 `tv.js:338805–338849` |
| Detail fetch | GET `/newtv/post.php?id=<catalog id>`, headers `Ott`, `Lastep`, `Usertoken`, X-Requested-With, fixed NewTV UA | #8866 `tv.js:334730–334780` |
| Detail result | Uses `type`, `main_id`, `episodes`, `season`, `last_ep`, `nextPage`, `nextPageSeason`, `nextPageShow` | #8867 `tv.js:334806–334875` |
| Language strip | FlatList `data=post.lang`, key `item.l`, display `item.l`; no press handler | #8923/#8924 `tv.js:336410–336470` |
| Season selector | `item.s` is displayed and used as key; `item.id` is sent to seasonData | #8898/#8899 `tv.js:337135–337235`; `tv.hasm:360193` |
| Season initial page | GET `/newtv/episodes.php?id=<selected season id>` (no explicit page query); replace episode list | #8877/#8878 `tv.js:335397–335500`; `tv.hasm:359386` |
| Episode pagination | GET `/newtv/episodes.php` with params `{id:<prior nextPageSeason>,page:<prior nextPage>}`; append episodes and update BOTH next cursors | #8889/#8890 `tv.js:335594–335720`; `tv.hasm:359736` |
| Episode labels/identity | `episode.ep` is displayed; `.id` is the playback ID. Selecting episode navigates Player with `{idx:episode.id,apiUrl,type,sid}` | #8902/#8904 `tv.js:337280–337420` |
| Player request | GET `/newtv/player.php?id=<idx>`, headers Ott/Usertoken/X-Requested-With/fixed UA | #8956/#8957 `tv.js:338760–338849`; `tv.hasm:363004` |
| Media URL | `player.video_link` assigned directly as video `source.uri`; `player.referer` as media Referer. No extra decoding/streamDomain rewrite | #8957 `tv.js:338810–338824`, #8941 `tv.js:340198–340209` |
| Media headers | `Referer:player.referer`, fixed Firefox136 `/OS.GatuNewTV v1.0` UA, `X-Requested-With:NetmirrorNewTV v1.0`; no OTP/Usertoken on media source | #8941 `tv.js:340198–340209` |
| Native track discovery | onLoad event arrays `audioTracks/textTracks/videoTracks` are stored | #8996 `tv.js:339645–339695`; `tv.hasm:364114` |
| Audio select | Index chosen; preference stored from selected track `.language` or `.title` as `preferredAudioLang` | #8979 `tv.js:339280–339345`; native prop `tv.js:340215–340219` |
| Audio default | Saved language matched case-insensitively by track.language or title substring; else English track; else index 0 | #8996/#8997/#8998/#8999 `tv.js:339680–339810` |
| Subtitle select/off | UI has Off at index0; native selectedTextTrack gets -1 when Off, otherwise UI index-1; stores language/title preference | #8987 `tv.js:339447–339535`; native prop `tv.js:340220–340223` |
| Quality select | Chosen native video-track index; stores its `.height` string under oddly named `preferredVideoLang` | #8983 `tv.js:339365–339430`; native prop `tv.js:340224–340227` |
| Quality default | Saved height matched; otherwise 1080 then 720 then first track | #8996/#9001 `tv.js:339890–340010` |
| Resume | Per catalog/episode `progress_<id>` stores `currentTime:duration`; series key points to last episode ID. Periodic save every3seconds and on exit; source-switch track preferences separate | #8948 `tv.js:338410–338465`; #8951 `tv.js:338470–338525`; details #8869 `tv.js:334955–335090` |
| Native retry/transport | source includes minLoadRetryCount5; onError shows error rather than implementing a new auth-cookie flow | #8941 `tv.js:340201`, onError `tv.js:340282–340310` |
| OTT list | GET `/newtv/ott.php`; uses `data.ott`, whose `item.value` becomes selected OTT code. Values are server-provided, not hardcoded3platforms | #8087/#8092/#8097/#8098 `tv.js:301649–302080` |
| Next episode | Details allows selecting episodes; inspected native video props hide native next/previous buttons. No wired `onEnd` auto-next was seen in this PlayerScreen | #8941 `tv.js:340228–340408` |

Header detail: seasonData/loadMoreEpisodes in this APK carry Ott/X-Requested-With/UA but not Usertoken in their constructed headers. Carrying Chitram's same origin-scoped token there is a compatible hardening, not evidence the APK does that.

## Phone APK boundary

The phone APK's main app uses `/check.php` to obtain a WebView URL and loads the live mobile site. Its inspected app-specific WebView does not implement native audio/quality/subtitle selection or a mobile TV-style token exchange. `streamDomain` belongs to the **download fetch-and-post workflow**, not a rewrite applied to TV video_link. Phone-page menus/verification can change server-side and cannot be fully reconstructed from this APK alone. See existing `docs/netmirror/mobile-native-cookie-flow.md` for the separate auth investigation.

## Concrete Chitram parity gaps at audit start

1. **Season-number selection:** backend used selected array index+1; Android used array index and `seasons[requested-1]`. APK displays explicit `season.s`. Out-of-order, sparse, or specials lists make an index map unsafe. Match explicit label/number first; validate episode's season where present; never silently substitute selected season.
2. **Episode pagination:** backend only collected current season plus hardcoded page2; Android loop incremented page1..20 and retained a fixed season ID. APK follows `nextPage` and `nextPageSeason`. Need exact cursor forwarding, duplicate-loop detection, and bounded budget that reports partial/unknown rather than a missing episode.
3. **Catalog rows:** backend `.slice(0,4)` can silently omit fifth or later dub/catalog rows, whereas app handles the entries returned by search/catalog UI. Preserve all matches subject to the existing call budget; do not cache a bounded partial lookup as complete.
4. **Native track truth:** display availability metadata must not imply native selection exists. Master/native tracks are authoritative for switchability. post.lang can label known single-language media but must not create imaginary audio renditions.
5. **Media header parity:** current Android media source omitted NewTV X-Requested-With; backend HLS media headers omitted it and rotated UA. HLS source should match inspected APK headers, while keeping separate embed-tmdb MP4's measured downloader Referer and no auth-header leakage.
6. **Quality/subtitle exposure:** native APK discovers tracks in the actual stream; backend previously returned bare HLS row with empty levels/subtitles despite fetching master to verify title. Retain manifest-derived variants/text evidence for menus, without pretending an HLS subtitle playlist is a VTT file.
7. **Dynamic OTT capability:** fixed nf/pv/hs is not demonstrated exhaustive. APK asks ott.php dynamically. Static evidence cannot prove Disney aliases hs or the set of live values. If full AllOTT coverage is desired, characterize one metadata response and implement bounded discovery. Chitram's TMDB-based catalog browsing remains its own UX and need not copy upstream home screens.
8. **Defaults:** APK defaults toward English; Chitram deliberately defaults Telugu. This is an intentional product difference that should be retained, not classified as a parity defect.

## Suggested deterministic fixtures (constructed, not captured live responses)

- Seasons `[{s:'Season 3',id:'season-three'},{s:'Season 1',id:'season-one',selected:true}]`; request S3E2 must fetch id=season-three, not array slot3 or selected Season1.
- Current post includes first episode, `nextPageShow:1,nextPage:7,nextPageSeason:'cursor-A'`; first continuation must request id=cursor-A&page=7. Response says nextPage11,nextPageSeasoncursor-B; next request must use both changed values.
- Same cursor repeated with hasMore remains1: stop safely and mark incomplete; do not tight-loop.
- 6 matching language-suffixed search rows: all remain eligible, regardless of prior4row cap; budget failure after row4 preserves first4 as partial rather than complete/empty.
- post.lang lists Telugu/Hindi but master only has Telugu audio rendition: actual selectable menu must not fabricate Hindi.
- Master lists actual audio Telugu/Hindi and subtitle playlist en.m3u8; native player discovers both; web exposes actual audio tracks and handles embedded subtitle playlist through HLS engine rather than raw VTT side-load.
- Track list reorder between two sources: saved language/height preferences reselect by meaning, then chosen native index, rather than retaining an old numeric index.

## Verification limits

This report establishes static contracts and specific code gaps. It does not validate currently accepted OTT values, complete live season numbering formats, expiry duration, current service throttling behavior, audible language, subtitle rendering, cast compatibility, or multi-language switching on hardware. Parent's existing live single-Telugu movie evidence is narrower than full parity.
