# Provider self-heal design (2026-11-21)

Status: draft for owner review. Plan: `docs/superpowers/plans/2026-11-21-provider-selfheal.md`.
Audit it builds on: `.superpowers/sdd/2026-11-21-audio-pairing-step2/provider-selfheal.md`.

## Intent

Every stream provider repairs itself without a human. A domain move, a key or token rotation, a dead host, or an outage that ends must heal on its own. A site change that code cannot follow must be fixable by editing one remote JSON, with no VM deploy and no APK release.

## Goals

1. One remote resolve-config JSON, read by the VM server and the APK. It holds hosts, keys, paths, token patterns and per-provider routing.
2. Host heal (redirect trail, mirror list, bundle scan) for every enabled provider, including multimovies, vidrock and OneTouchTV, which have none today.
3. Key and token auto-extraction where a provider publishes its key in a public page or bundle: vidrock, OneTouchTV, VaPlayer.
4. A canary on the VM that runs each provider's own resolve on a fixed title, classifies the failure, triggers the matching heal, and records state. It closes the breaker when the provider is back.
5. Stop futile work: a Cloudflare challenge or an IP gate is "blocked", not "moved". No rediscover loop on it.
6. APK keeps working with the VM down: cached config, built-in defaults, HostBook heals, on-device resolvers.

## Non-goals

- No alerts, notifications, GChat, Telegram or admin page (owner: deferred). State is recorded and readable on `/api/status` only.
- No misuse or abuse hardening of the config (owner: ignore for now). No signing.
- No canary or benchmark of NetMirror/newtv. Zero extra newtv requests.
- No auto-rewrite of extractor logic. A changed JSON shape, PoW format or WASM ABI still needs code. The design detects and records it ("drift"), and keeps the breaker from wasting requests.
- No server-side heal for mapple (APK-only by owner rule; Cloudflare 403 from the VM IP only).
- Heals never write back to the remote file. Remote is human-edited only.

## Binding constraints

- CLAUDE.md #1 and #2: a heal changes a host, key, token or path only. It never touches language, audio or video fields. A heal is applied only after the provider's own resolve returns rows through the same `streamSchema` path, so tags come from the same code as today.
- CLAUDE.md #4: `masterMatchesTitle` stays on. Nothing here calls around it.
- CLAUDE.md #5: NetMirror is excluded from the canary. Its own `checknewtv.php` rediscovery (one request after 2 failures or 10 min) is unchanged.
- Few knobs: one new env var on the server (`RESOLVE_CONFIG_URL`), one URL constant in the APK. Cadences are constants.

## Measured: how each provider gets its host and keys today

Static reading, file:line from the working tree on 2026-11-21.

| Provider | Host source | Key/token source | Fails on site move | Existing heal |
|---|---|---|---|---|
| castletv | `CASTLE_BASE` const `providers/castletv.js:8`, `UPSTREAM` `:9`, `castleBase()` `:10`. APK `CastleResolver.kt:159` const | Security key per session `/v0.1/system/getSecurityKey` (`castletv.js:95-96`). Suffix `T!BgJB` `:42`, AES-128-CBC key=IV `:52`. API versions v1.1.0/v1.9.9/v2.0.1 in URLs | DNS-dead host: no trail. Suffix change: garbage JSON | Redirect trail via registry (`providers/registry.js:97-122`) |
| multimovies | `ORIGIN = 'https://vidbolt.xyz'` `multimovies.js:41`, Referer/Origin from it `:53`. APK `MultiMoviesResolver.kt:66` | None | Every call errors; breaker trips; no rediscover (no `UPSTREAM`, exports `:277-287`) | None. Heal sources measured: site title page, Nuvio scraper constant, sibling `vidbolt.pro` (table below) |
| vidrock | `API_BASE` `vidrock.js:39`, Referer/Origin `:46-47` | `STREAM_KEY` hex const `:40`; decrypt `:55-60` uses CTR, ignores GCM tag | Host: errors. Key: every row "decrypted value is not a URL", provider returns `[]`, which only counts on mainstream ids | None |
| onetouchtv | `MAIN_URL` `onetouchtv.js:9`, Referer `:14` | `AES_KEY` `:10`, `AES_IV` `:11`, decrypt `:74-83` | Host: errors. Key: `decipher.final()` throws or JSON.parse throws | Last-good 30 min cache `:24-33` |
| showsst | `MIRRORS` `showsst.js:39-46` + env, `UPSTREAM` with player `:54` | None (header gate) | Mirrors tried, then rediscover | Redirect + player bundle scan |
| vaplayer | `WRAPPER_ORIGIN` `vaplayer.js:24`, `UPSTREAM` `:25`, `STREAM_API` const `:4`, `PLAYER_ORIGIN` `:5` | `apiToken` regex `:57`; WASM by `wasm_url` `:62-77` | Host: redirect. Token: "no apiToken" error `:102` | Redirect; WASM key rotation heals |
| mapple | `BASE` `mapple.js:36` + env, `UPSTREAM` `:37` | PoW + `/api/encrypt` (hardcoded) | VM: Cloudflare challenge, not a move | Redirect; APK HostBook |
| netmirror | Bootstrap list `netmirror.js:172` (base64), `NEWTV_DOMAINS` env `:278`, web mirrors `:214` | otp.php flow | Discovery while one bootstrap domain lives | `checknewtv.php` own loop `:274-300` |

Shared machinery:
- Host heal: `utils/upstreamBase.js:255-319` (redirect, player bundle, aggregator, verify on 27205, persist `data/provider-bases.json` `:46-49`, `save()` `:78-91`). `save()` runs only after a verified apply, and no apply ever passed, so the file was never written. That is expected, not a write bug.
- Breaker: `lib/runtime/metrics.js:41-42` (5 misses, 10 min), `:96-124`. State in `provider_health` (`utils/store.js:83-94`).
- APK config: `ResolveConfig.kt` parses `mapple`, `vaplayer`, `netmirror` only, ignores unknown keys. Fetch URL is `Api.BASE + /api/resolve-config` (`App.kt:58`, `Api.kt:119` = `https://chtrm2.vercel.app`), which Vercel rewrites to the VM (`web/next.config.mjs:45`). So with the VM down the APK keeps its cached copy only. Retry gap 10 min, timeout 4 s (`ResolveConfig.kt:264-265`).
- Server config file `routes/resolve-config.json` is a repo file served per request (`routes/resolveConfig.js`). The server providers do not read it.

## Measured: live heal signals (laptop, 2026-11-21 13:13Z to 13:15Z; multimovies rows 3-8 at 13:22Z to 13:24Z)

Each line is one HTTP request. NetMirror/newtv: 0 requests.

| Provider | # | Request | Result | Heal signal it confirms |
|---|---|---|---|---|
| vaplayer | 1 | `GET vaplayer.ru/embed/va_src.php?path=/embed/movie/tt1375666` | 200, 156 b, `{src: nextgencloudfabric.com/embed/movie/...}` | Wrapper alive |
| vaplayer | 2 | `GET <src>` | 200, 38,683 b. `const CONFIG = {...}` holds `apiToken` (current regex matches), `streamDataApiUrl`, `rateLimited:false`, `apiTokenRefresh:false`. Token payload carries the caller IP | From a residential IP the token is there. The VM "no apiToken" is most likely an IP gate, not regex drift (VM side unverified). CONFIG is a parseable object: read `apiToken` and `streamDataApiUrl` from it, and read `rateLimited` to classify "blocked" |
| vidrock | 1 | `GET vidrock.net/movie/27205` | 200, 657,837 b, 0 redirects, script `/assets/index-BR3xSMW9.js` | Bundle name is discoverable from the page |
| vidrock | 2 | `GET /assets/index-BR3xSMW9.js` | 200, 1,410,186 b. Current `STREAM_KEY` appears once and is the only 64-hex literal. Code uses `crypto.subtle.importKey(... AES-GCM ...)` | Key auto-extract works. GCM tag gives a yes/no key check with no title play |
| onetouchtv | 1 | `GET onetouchtv.xyz/` | 200, 38,345 b, Flutter web app | Front alive |
| onetouchtv | 2 | `GET onetouchtv.xyz/main.dart.js` | 200, 845,943 b. Key literal once in `mP(){var s="im72...",r=B.d.a2(s,0,16)` (IV = first 16 chars). API host literal `$.aGL="https://api3.devcorp.me"`. 10 32-char literals | Key and API host auto-extract work. Valid JSON after decrypt is the key check |
| multimovies | 1 | `GET vidbolt.xyz/movie/27205` | 200, 8,475 b, Cloudflare, inline `/api/resolve`, sister host `stats.vidbolt.pro` | Host alive; API path is readable from the embed page |
| multimovies | 2 | `GET multimovies.wtf/` | 200, 47,581 b, names `m1.multimovies.courses` 9 times | A landing page that names the current site (mirror-list signal) |
| multimovies | 3 | `GET m1.multimovies.courses/movies/krack/` (13:22:11Z) | 404, 23,190 b. Site is no longer WordPress/DooPlay; title URLs are `/movie/<slug>-<siteId>` | Title slug cannot be guessed: search first |
| multimovies | 4 | `GET m1.multimovies.courses/search?q=inception` (13:22:29Z) | 200, 33,237 b, one hit `href="/movie/inception-8559"` | Search finds the title page. Regex `href="(\/movie\/inception-\d+)"` |
| multimovies | 5 | `GET m1.multimovies.courses/movie/inception-8559` (13:22:36Z) | 200, 57,310 b. `const watchConfig = {...}` JSON, `initialServers` 6 entries, one is `{"id":"autoembed_6","name":"Vidbolt","url":"https:\/\/vidbolt.xyz\/movie\/27205"}`. Same list as `<button class="server-chip" data-url=...>` with `<span class="server-name">Vidbolt</span>` | **Title page names the VidBolt host.** Primary: parse `watchConfig` JSON, pick `initialServers` with `name` `/^vidbolt$/i`, take `new URL(url).origin`. Fallback regex, anchored on the label not the host: `/<button[^>]*data-url="(https?:\/\/[^\/"]+)\/movie\/\d+"[^>]*>(?:(?!<\/button>)[\s\S])*?server-name">\s*vidbolt\s*</gi`. Both return `https://vidbolt.xyz` on the saved page |
| multimovies | 6 | `GET raw.githubusercontent.com/mayurgj/nama/main/providers/multimovies.js` (13:23:00Z, text only, not run) | 200, 58,070 b, "NAMA multimovies provider v1.3.1". Hardcodes `{ name: "VidBolt", url: "https://vidbolt.xyz/movie/" + id }` (fallback list `mmDirectServers`), `SITE.base = "https://m1.multimovies.courses"`, `MM_HOME = "https://multimovies.wtf/"`. Its primary path reads the same `watchConfig.initialServers` | Second heal source for both the VidBolt host and the current site. VidBolt regex `/name:\s*"VidBolt",\s*url:\s*"(https?:\/\/[^\/"]+)\/movie\//`; site regex `/var SITE = \{[^}]*base:\s*"(https?:\/\/[^"]+)"/`. Its extractor dispatch is `/vidbolt\./`, so a rename off the `vidbolt` name may lag there |
| multimovies | 7 | `GET vidbolt.pro/api/resolve?type=movie&id=27205` (13:23:32Z) | 200, 1,177 b JSON, md5 `642d2366...` | Sibling TLD of `stats.vidbolt.pro` (seen on the embed page) is a live mirror of the same API |
| multimovies | 8 | `GET vidbolt.xyz/api/resolve?type=movie&id=27205` (13:23:33Z) | 200, 1,177 b, `application/json`, same md5 as row 7. 1 source, `kind:"hls"`, master **inline** in `source.master` with 2 `#EXT-X-MEDIA:TYPE=AUDIO` (eng, hin) | Validation needs no extra request: the AUDIO check reads `source.master` |
| castletv | 1 | `GET api.hlowb.com/v0.1/system/getSecurityKey/1?...` | 200, 49 b, `{"code":200,...}` | Host alive. No public bundle for suffix or versions (it is an Android app) |
| showsst | 1 | `GET player.vidqueen.st/` | 200, 13,955 b, one script `/rt.js` | |
| showsst | 2 | `GET player.vidqueen.st/rt.js` | 200, 69,049 b, no `https://api.*` host | Bundle trail NOT confirmed on this mirror |
| showsst | 3 | `GET player.vidqueen.st/movie/27205` | 404 | |
| mapple | 1 | `GET mapple.fun/watch/movie/27205` | 200, 100,643 b, Cloudflare, 0 "Just a moment" | Works from a residential IP, as the audit said. On-device is the right home |

Commands: `curl -sS -m 15 -w '%{http_code} %{size_download}b ...'` per row, bodies kept in the session scratchpad, not in the repo.

## Approaches considered

| | Approach | For | Against |
|---|---|---|---|
| A | Keep config on the VM (repo file, or a VM-writable file edited over SSH) | No new host | A human fix needs SSH or a deploy. APK cannot refresh while the VM is down |
| B (pick) | Layered config: built-in defaults, then a remote JSON at a static URL outside the VM, then VM heals. VM serves the merged view on `/api/resolve-config`. APK fetches the VM first and the remote URL when the VM fails | A JSON edit fixes server and APK with no deploy. Works with the VM down. Heals reach the APK through the VM | One more host to own. File is public (accepted: hosts and keys are already public in the sites' own bundles) |
| C | Vercel Edge Config / KV | Fast edge reads | Vendor token on the VM and APK, more moving parts |
| D | Push heals back into the remote file (auto-commit) | One source of truth | Machine writes to a human file; a bad heal spreads to every client; needs write credentials on the VM |

Canary options: (1) in-process timer in the API, (2) separate cron process, (3) none, breaker half-open only. Pick (1): the API already runs timers (`apiServer.js:571`), it shares the provider modules, heal store and breaker, and needs no new pm2 app (the VM rules forbid touching the fleet's pm2 dump).

## Design

### 1. Config layers (server)

`lib/selfheal/config.js` holds one merged object:

```
built-in   routes/resolve-config.json (repo, as today)
  < remote RESOLVE_CONFIG_URL (fetched, ttlSec, last good kept on disk)
  < heals  data/provider-heals.json (machine-written, verified only)
```

- Fetch on boot and every `ttlSec` (file default 21600 s). Timeout 4 s. A failed fetch keeps the last good copy (`data/resolve-config.remote.json`); no copy means built-in only.
- A remote doc that fails to parse, or has `version` lower than the last good one, is ignored.
- Field rule: a value missing or of the wrong type falls back to the layer below (same rule `ResolveConfig.kt` uses).
- Heal precedence: a heal records the remote value it replaced (`over`). When the remote value of that field changes, the heal is dropped. A human edit always wins over an old heal.
- Providers read through `cfg(provider, field, fallback)` at call time, so a refresh needs no restart. Today's constants become the `fallback`, so with no remote and no heal the behaviour is exactly today's.

### 2. Remote config format

Same file shape as `routes/resolve-config.json` (`version`, `ttlSec`, one object per provider). New provider objects and one `routes` map. Unknown keys are ignored by old APKs.

```json
{
  "version": 2,
  "ttlSec": 21600,
  "routes": {
    "castletv":    { "web": "direct", "apk": "direct" },
    "multimovies": { "web": "proxy",  "apk": "direct" },
    "mapple":      { "web": "off",    "apk": "device" },
    "vaplayer":    { "web": "off",    "apk": "device" },
    "vidrock":     { "web": "proxy",  "apk": "proxy" }
  },
  "castletv":    { "bases": ["https://api.hlowb.com"], "keySuffix": "T!BgJB",
                   "apiVersions": { "search": "v1.1.0", "details": "v1.9.9", "video": "v2.0.1" } },
  "multimovies": { "bases": ["https://vidbolt.xyz", "https://vidbolt.pro"], "resolvePath": "/api/resolve",
                   "sites": ["https://multimovies.wtf"],
                   "scrapers": ["https://raw.githubusercontent.com/mayurgj/nama/main/providers/multimovies.js"] },
  "vidrock":     { "bases": ["https://vidrock.net"], "key": "<64 hex>" },
  "onetouchtv":  { "bases": ["https://api3.devcorp.me"], "front": "https://onetouchtv.xyz",
                   "key": "<32 chars>", "iv": "<16 chars>" },
  "showsst":     { "mirrors": [{ "api": "https://api.vidqueen.st", "player": "https://player.vidqueen.st" }] },
  "vaplayer":    { "...existing fields...": "" },
  "mapple":      { "...existing fields...": "" },
  "netmirror":   { "...existing fields...": "", "webMirrors": ["..."] }
}
```

Routing vocabulary: `web: off|direct|proxy`, `apk: off|direct|proxy|device`. The loader maps `off` to today's surface `none` and `device` to `on-device`, and `direct`/`proxy` to `PROVIDER_ROUTES` values. `hostPatterns` and `hosts` keep their shape, with `re` as a string. The built-in default for `routes` is today's `PROVIDER_ROUTES` and `PROVIDER_SURFACES` (`lib/routing/providerRoutes.js:30-72`), so an empty remote changes nothing. This step waits until the routing work is committed (it is uncommitted and under review).

### 3. How the APK fetches, caches and falls back

1. `GET Api.BASE/api/resolve-config` (VM merged view: built-in + remote + heals). As today.
2. On failure, or when `api.vmUp` is false: `GET REMOTE_CONFIG_URL` (the same remote file, no heals).
3. Both fail: last good copy in KeyValue, even if stale (as today).
4. Nothing ever fetched: built-in defaults (as today).
5. On-device HostBook heals (7-day memory) sit on top of whichever config won.

New parsed sections: `castletv.bases`, `multimovies.bases`, `routes.*.apk`. Castle and MultiMovies resolvers move onto HostBook with those bases. On-device fallback stays as is.

MultiMovies on the APK takes the VM-healed host: the VM merged view puts a verified heal first in `multimovies.bases`. HostBook then tries those bases in order and follows a cross-host redirect. The APK does not run the title-page or scraper trail itself (one implementation, no extra device requests). Gap: VM down and VidBolt moved at the same time heals only after a human edits the remote `bases`.

### 4. Heal kinds

| Kind | Signal | Action | Verify before apply |
|---|---|---|---|
| host | Connection/DNS error, 404/410 on the API root, cross-host 301/302 | Existing `rediscover` trails plus new trails: multimovies VidBolt chain (below), bundle host literals (onetouchtv), remote `bases`/`mirrors` list | Provider's own resolve of Inception 27205 returns at least 1 row. multimovies also: a source whose master has `#EXT-X-MEDIA:TYPE=AUDIO` |
| key | vidrock: GCM tag fails. onetouchtv: CBC padding or JSON parse fails. 3 in a row | Fetch the front page, then its main bundle. Candidates: 64-hex literals (vidrock), 32-char literals with IV = first 16 (onetouchtv). At most 2 page requests plus 1 API call | Candidate decrypts a fresh API answer: GCM tag passes, or CBC yields JSON. Then 27205 resolves |
| token | vaplayer: page answered, regex missed | Parse `const CONFIG = {...}` as JSON. Read `apiToken`, `streamDataApiUrl`. If `rateLimited` is true or `apiToken` empty: classify blocked | Next resolve gets rows |
| blocked | Cloudflare "Just a moment", 403 with `cf-mitigated`, vaplayer `rateLimited` | No heal. Stop rediscover for this provider. For providers with an APK on-device resolver (`routes.apk = device`), the server skips them until a canary passes | Canary pass |
| drift | Page or API answered 200 but the parser found nothing expected (shape change) | Record only. Config may fix it if the field is parameterised (paths, regex, versions) | Canary pass |
| down | Timeouts and 5xx on every candidate | Nothing; breaker handles it. Canary retries | Canary pass |

Classifier: `lib/selfheal/classify.js`, a pure function from `{error, status, body snippet}` to a kind. Tested on the real `lastErr` strings in the audit.

### 5. Per-provider heal strategy

| Provider | Host heal | Key/token heal | VM canary | Notes |
|---|---|---|---|---|
| castletv | Redirect + remote `bases` (server). APK: HostBook + `castletv.bases` | Security key already per session. Suffix and API versions from remote config (human edit; no public source) | Yes | Telugu-first source; canary also runs Krack 784572 |
| multimovies | New `UPSTREAM`. VidBolt chain: redirect, remote `bases`, title-page trail, Nuvio scraper constant. APK: HostBook over the VM-healed `bases` | None needed. `resolvePath` from config | Yes | Title-page trail measured (rows 3-8): the title page names the VidBolt host |
| vidrock | New `UPSTREAM`. Redirect + remote `bases` | Auto-extract from `/assets/index-*.js` with GCM tag check (measured) | Yes | Switch decrypt to `aes-256-gcm` with tag so a wrong key is a clear error, not an empty answer |
| onetouchtv | New `UPSTREAM`. Redirect + `$.xxx="https://api*"` literals in `main.dart.js` + remote `bases` | Auto-extract key and IV from `main.dart.js` (measured) | Yes | 404 flakiness keeps its last-good cache |
| showsst | Existing redirect + bundle scan + remote `mirrors` | n/a (header gate: drift, human edit) | Yes | Bundle trail not confirmed live on vidqueen.st (3 requests) |
| vaplayer | Existing redirect + remote `wrapperBases` | Parse CONFIG object; `streamDataApiUrl` replaces the `STREAM_API` const | Yes, 6 h; blocked state likely on VM | APK uses the same CONFIG fallback when its regex misses |
| mapple | APK only: HostBook + remote `bases` | n/a | No (VM blocked by Cloudflare) | Server marks it blocked and stops its 30-min rediscover |
| netmirror | Unchanged `checknewtv.php` loop. Bootstrap domains and web mirrors also read from remote config | n/a | No. Zero canary requests | Passive state only: failure count from real traffic |

#### multimovies: VidBolt discovery chain

Runs on classifier `host` for multimovies (for example `ENOTFOUND vidbolt.xyz`, 404/410 on `/api/resolve`). Steps run in order and stop at the first candidate that validates. Hosts already tried in this run are skipped.

1. Redirect: `GET <base>/movie/27205`, no auto-follow. A cross-host `Location` is a candidate (existing `rediscover`).
2. Remote `bases`: each `multimovies.bases[]` entry in order (built-in second entry `vidbolt.pro`, measured row 7).
3. Title-page trail, per `sites[]` entry. `GET <site>/`: current site = most frequent `https?://([a-z0-9-]+\.multimovies\.[a-z]{2,})`. `GET <current>/search?q=inception`: `href="(/movie/inception-\d+)"`. `GET <current><path>`: VidBolt origin from `watchConfig.initialServers` (`name` `/^vidbolt$/i`), else the label-anchored button regex (row 5). 3 GETs.
4. Nuvio scraper, per `scrapers[]` entry. One GET of the raw file as text, never run. The VidBolt regex gives a candidate. The `SITE.base` regex gives a current site: if step 3 failed on its landing page, rerun step 3 from that site.
5. Validation of every candidate, 1 GET: `<cand>/api/resolve?type=movie&id=27205`, Referer `<cand>/movie/27205`. Pass needs https, JSON, and at least one `stream.sources[]` with `kind:"hls"` whose master (`source.master`, else one GET of `source.url`) has `#EXT-X-MEDIA:TYPE=AUDIO`. Then the provider's own resolve of 27205 returns at least 1 row (global rule). Only then `setBase('multimovies', cand, how)` with `how` = `redirect|config|titlepage|scraper`.
6. Caps: at most 3 candidates validated and 12 GETs per run. Cooldown 30 min (`upstreamBase` `COOLDOWN_MS`). A candidate that fails validation is logged `[heal] multimovies reject <host> <reason>` and never adopted.

### 6. Canary loop and state store

- Timer in the API process, `unref()`'d, ticks every 10 min. Each tick runs at most one provider (the most overdue). So at most 6 canary runs per hour in total.
- Due rule: healthy, every 6 h. Not healthy (last canary failed, breaker open, or fail streak 5+), every 30 min. Blocked or drift, every 6 h (requests will not fix it).
- A run: the provider's own resolve on Inception 27205. For castletv, multimovies and vidrock also Krack 784572, and record whether a Telugu-tagged row came back (`telugu_ok`). Same code path as a user request, so the same `streamSchema` tagging.
- Pass: reset breaker (`recordProviderOutcome(name, 'hit')`), clear fail streak, state `ok`.
- Fail: classify, run the heal for that kind once, then re-run 27205 once if a heal was applied.
- Excluded: netmirror (owner rule), mapple (on-device). Disabled providers are skipped.
- Store: new table `provider_canary` in `data/learning.sqlite` (additive migration in `utils/store.js` MIGRATIONS; JSON fallback backend gets the same key):

```
provider text primary key, state text, kind text, last_run_at int, last_ok_at int,
next_due_at int, last_error text, telugu_ok int, heal_how text, heal_at int, runs int, fails int
```

- Heals (host and key values) live in `data/provider-heals.json`, a generalised `provider-bases.json` (read once for migration). Atomic write as today. Entry: `{ field: { value, how, over, verifiedAt } }`.
- `/api/status` gains a `heal` object per provider from this table. Pull only, no push.

### 7. Failure modes

| Failure | Behaviour |
|---|---|
| Remote URL down or returns garbage | Last good copy, then built-in. Logged once per fetch |
| Remote edit is wrong (bad host) | Providers fail; canary classifies host; rediscover tries trails and the previous good values. Human edit reverts |
| Heal verified but wrong later | Next canary fails; heal is re-checked; a 7-day TTL (`upstreamBase` `TTL_MS`) drops unconfirmed heals |
| Key extract finds several candidates | Each is tried against one fresh ciphertext; none passes means no apply |
| VM IP blocked (mapple, maybe vaplayer) | State `blocked`, no rediscover loop, server skips the provider for APK callers; APK resolves on device |
| VM down | APK: cached config, remote URL, HostBook, on-device resolvers. Web: down with the VM (as today) |
| `data/` not writable on VM | Heals live in memory for the process; one startup warning. Not verified on the VM yet |
| Extractor drift (new JSON shape, PoW, WASM ABI) | State `drift`; breaker limits cost; needs code. Not self-healable by design |
| NetMirror throttle | Unchanged guard and `masterMatchesTitle`; no canary traffic adds to it |
| Canary costs during a long outage | Max 48 runs/day for one unhealthy provider, 4/day healthy, 4/day blocked |

## Open questions for the owner

1. Where does the remote JSON live: a public GitHub gist, a public config repo, or a static file on Vercel (needs a web deploy per edit)? Which account?
2. When the canary marks mapple or vaplayer `blocked` on the VM, may the server skip them for APK callers too (the APK resolves them on device)?
3. Cadence: 6 h healthy, 30 min unhealthy, max one provider per 10 min. Acceptable?
4. Route vocabulary: code has `direct|proxy` plus surfaces `none|on-device`. Config uses `off|direct|proxy|device`. Confirm.
5. vaplayer from a residential IP still gets `apiToken`. Accept the VM failure as an IP gate (state `blocked`) without more VM probing?
