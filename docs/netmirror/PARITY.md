# NetMirror playback parity audit — 2026-11-21

This is playback-provider parity inside Chitram's TMDB-based website and Android
app. It does not replace Chitram's catalog UI with NetMirror home screens or
copy upstream account history. Telugu-first and adaptive quality remain
Chitram defaults; the inspected TV APK favors English and a fixed video height.
The phone APK delegates its player to a live website, so static phone bytecode
alone cannot establish every behavior of that changing site.

## Implemented contracts

| Capability | Website/API | Android | Evidence |
|---|---|---|---|
| OTP and token lifecycle | Origin/OTP-scoped, single-flight; known unauthenticated player pre-authenticates; one renewal bound | Device-only session; one renewal bound | Node/session and MockWebServer tests; live token issuance |
| Catalog discovery | Authenticated `/newtv/ott.php`, ten-minute cache; fallback explicitly incomplete | Same dynamic registry and bounded fallback | Live registry returned nf/pv/hs; fourth-catalog fixtures |
| All matching catalog/dub rows | No four-row truncation; SD/HD MP4 and HLS retained | Multirow resolver → start race → late merge/recovery | >4-dub tests; source identity and late-arrival tests |
| Available vs playable language | `catalogLanguages` stays informational; actual master audio owns selectable tracks | Raw audio metadata survives DTO mapping; ISO2/3 names canonicalized | Phantom-language and Ces/Fil duplicate regressions |
| Requested season | Explicit season `.s` number and `.id`, including `Season 2 (9 EP)` | Same; selected season is not assumed to be requested | Live default Season 5 → requested S2E1; shuffled-season tests |
| Episode pages | Follows both returned nextPageSeason and nextPage, caches prior pages and rejects repeated cursors | Same cursor-based lookup, cancellation and request budget | Page3/retry/repeated-cursor tests |
| Qualities | Actual HLS levels/codecs plus every returned MP4 rung | Native Media3 tracks and actual master levels | Live 1080p/720p master and phone quality menu |
| Media transport | APK NewTV UA, Referer and X-Requested-With; proxy handles forbidden browser headers | Separate credential-free media client carries required headers | Credential isolation and header tests; live playback |
| Real audio selection | Existing HLS track menu plus whole-source/pairable choices | Actual track overrides; explicit chosen source language survives source/renewal changes | Live phone Telugu → Tamil; adapter/menu tests |
| Captions | Embedded HLS subtitle playlists stay in HLS engine | Embedded playlists stay in Media3, not mislabeled as VTT | HLS metadata/side-load tests; visible caption rendering not yet verified |
| Partial results | Distinct good/new rows unioned; explicit pending label and user-driven Check for more sources, including TV browser | Completed rows survive timeout; pending status retained | Budget continuation and old rejected-row non-resurrection tests |
| Source continuity | Stable URL/quality IDs, merge-only supplemental requests, stale-title cancellation | All completed jobs listened to; fallback picks untried IDs; title-scoped selected audio | Start-race/recovery/selection tests |

## Additional website season-selector fix

A cold `getTitleFull` could receive rich TMDB data before its optional fast
Cinemeta record. It returned `fromTmdb` immediately and lost the rich season
list/credits. The page then exposed only Season 1 even though rich metadata
contained all five seasons. The rich-only branch now performs full enrichment;
fast-only and both-failed branches remain explicit. Characterization reproduced
two failures before the fix; regression tests cover TV, movies and both failure
branches. A real browser reload then displayed all five Stranger Things seasons
and opened Chapter One: MADMAX from Season 2.

## Live observations

One catalog-metadata lookup returned Netflix (`nf`), Prime (`pv`) and Hotstar
(`hs`). One series case was traced, Stranger Things S2E1 on Netflix:

- `post.php` selected Season 5 by default, while Season 2's explicit ID was
  80117715. `/episodes.php?id=80117715` returned nine episodes.
- Requested episode 80117716 produced a successful HLS master whose video ID
  was also 80117716. The master listed 22 audio renditions, including Telugu,
  Tamil and Hindi, and 1080p/720p video variants.
- Signed Chitram 1.2.8 was installed with app data preserved on the connected
  OnePlus CPH2447. The app opened S2E1, NetMirror landed, its native audio menu
  showed Telugu selected, and choosing Tamil changed the player header to
  `netmirror · Tamil` without selecting another video source.
- The native quality menu listed Auto, 1080p and 720p. Quality selection and
  rendered captions were not completed on hardware after the phone left
  Chitram; no further cross-app controls were sent intentionally.

The local website's first cold series lookup can exhaust the six-call request
budget because the requested season needs an additional metadata request.
It keeps playable MP4 rows and marks them incomplete. Explicit continuation
reuses cached metadata after budget capacity replenishes. No request budget,
wrong-video guard or IP refusal was disabled to make a test pass.

## Verification limits

Automated tests cover supported protocol fields and continuation branches;
this is not a guarantee that every upstream title/catalog is present or that
an upstream session never expires. Original mobile ad/cookie completion is
still unresolved and is not an automatic fallback. Live public deployment,
cast transport and caption rendering have not been claimed verified here.
See the APK contract report for exact bytecode function IDs and the separate
mobile-session evidence for that unresolved flow.
