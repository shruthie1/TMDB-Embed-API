# Chitram Android app (2026-11-20)

One APK for Fire TV, Android TV and phones. Native Kotlin and Compose with a media3 player. Code: `android/`. Signed build: `~/Documents/Projects/local/chitram-android/Chitram-1.0.1.apk` (versionCode 2, 2,136,729 bytes). 1.0.0 was 1,998,227 bytes.

## Native, not WebView

The target is a 2018 Fire TV Stick 4K (AFTMM, Android 7.1.2, SDK 25). Its system WebView runs the Next.js app slowly, and video in a WebView uses the HTML5 path with no codec control. Native gives:

- media3 with HLS, direct codec checks (MediaCodecList) and decoder fallback.
- D-pad focus that Compose for TV handles without JS focus code.
- A 2 MB APK and a 0.3 to 1.0 s cold start (measured below).

The backend stays the same. The app calls the same public API as the web app.

## Screens

| Screen | TV (tv-material) | Phone (Material3) |
|---|---|---|
| First run | Language picker, Done or Skip | Same, with chips |
| Home | Hero for the focused title, then rows | Poster hero, rows, bottom nav |
| Search | Text field, results grid | Text field, results grid |
| Detail | Play or Resume, My list, seasons, episodes | Same, episode list |
| Player | D-pad controls, side menus | Touch controls, landscape |

Home row order: Continue watching, New in Telugu, Trending, Top 10 in India, Latest Hindi, Popular Telugu shows, My list. Telugu is the primary row unless the viewer's languages exclude it.

TV focus: each row has a focus requester and `focusRestorer`. Up and Down call `moveRow`, so focus never skips a row. Back returns to the last focused card.

TV hero: a Continue watching card shows two lines of overview. Progress saves the overview from 1.0.1. Older entries take it from the catalogue rows, My list, or one cached title fetch.

TV Search: the keyboard keeps D-pad Down while it is open. The IME action (Search) closes it and moves focus to the first result. With the keyboard closed, Down from the field also goes to the first result.

Player controls: -10s, Play/Pause, +10s, Server, Audio, Quality, Subtitles. They hide after 4 s. With controls hidden, Left and Right seek and Center toggles play. Back closes a menu, then hides controls, then leaves.

MediaSession (media3-session): the remote's media keys pass through the system to the session, which drives the player. The item metadata (title, episode, overview, backdrop) feeds the system now-playing view.

## Data flow

1. `Api` (OkHttp, 20 MB cache) calls `https://chtrm2.vercel.app`: `/api/rows`, `/api/search`, title, season and `/api/streams/{movie|series}/{id}`.
2. `Ranking` ports `backend.js` and `trackChoices.js`. Order: unsupported codec last, then tier (hybrid, preferred language with selectable audio, preferred, selectable, other), then HLS before progressive, then height. HEVC sources stay in the list. They only rank last when the device has no HEVC decoder.
3. `PlayerVm` plays the first source. On a 403 or 410 it fetches streams again with `refresh=1`, once. On other errors it moves to the next untried source. If no frames render for 6 s while the position moves, it also moves on.
4. `ProgressStore` (SharedPreferences) saves position every 10 s and on pause. A title counts as finished at 95% or 30 s from the end. Continue watching and next episode come from this store.
5. Images use Coil with the same OkHttp client: w342 posters, w780 and w1280 backdrops.

## Verified

- Unit tests: 27 pass (ApiParsing 8, Ranking 10, Store 5, V101 4), on real fixtures from 2026-11-20.
- TV emulator (Android 14 TV), 1.0.1: Search "peddi", Search key on the on-screen keyboard closed it and focused the first card. Down from the field (keyboard closed) focused the first card, not the nearest. Peddi played, position 60.5 s to 69.5 s in 10 s. KEYCODE_MEDIA_PLAY_PAUSE paused and resumed through the session ("Media button session is com.chitram.app"). Continue watching hero showed two overview lines.
- Phone emulator (Pixel 6, Android 14), 1.0.1: Detail, Resume, position 244.8 s to 254.8 s in 10 s, media pause through the session. The video surface now fits a 20:9 landscape screen (1920x1080 at x=240). Before, it overflowed the bottom.
- Earlier (1.0.0): TV Home, row focus, Detail, HEVC playback, Audio menu, Back order. Phone Home, My list, Server menu, Resume.
- Fire TV: 1.0.0 installed and launched in 986 ms. 1.0.1 not installed: `adb connect 192.168.31.242:5555` timed out at 15:13:43 and 15:15:19 IST, and ping reported "Host is down" (the stick was off or off the network).

## Left to do

- Play a title on the real Fire TV, with the display on.
- Device pairing (`/hybrid/pair`) is not ported.
- No Baseline Profile.
