# Provider self-heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every stream provider heals itself from a domain move, a key or token rotation, a dead host, or an outage that ends, with no human. A site change code cannot follow is fixed by editing one remote JSON, with no deploy and no APK release.

**Architecture:** Three config layers (built-in file, remote JSON at `RESOLVE_CONFIG_URL`, VM heals in `data/provider-heals.json`), merged in `lib/selfheal/config.js`. Providers read hosts and keys through it at call time. A pure classifier maps a failure to host, key, token, blocked, drift or down. Key extractors read public bundles (vidrock, OneTouchTV) and the VaPlayer CONFIG object. An in-process canary runs one provider per 10 min, triggers the matching heal, closes the breaker on a pass, and records state in `provider_canary`. The VM serves the merged view on `/api/resolve-config`; the APK falls back to the remote URL when the VM is down.

**Tech Stack:** Node (CommonJS, `node --test`), Kotlin (JUnit via gradle). No new deps.

**Spec:** docs/superpowers/specs/2026-11-21-provider-selfheal-design.md
**Audit:** .superpowers/sdd/2026-11-21-audio-pairing-step2/provider-selfheal.md

## Global Constraints

- No alerts, notifications or admin page. State goes to the store and `/api/status` only.
- NetMirror/newtv: no canary, no sweep, no benchmark, no new request path. Its `checknewtv.php` loop is unchanged. Tests stub every fetch; no test touches the network.
- Do not disable `masterMatchesTitle` (`providers/netmirror.js:613`, called at `:934`).
- A heal changes a host, key, token or path only. It never adds, removes or rewrites language, audio or video fields (CLAUDE.md #1). A heal is applied only after the provider's own resolve returns at least 1 row for Inception 27205.
- Telugu first: the canary runs Krack 784572 for castletv, multimovies and vidrock and records `telugu_ok`. vidrift runs RRR 579974 in place of 27205 (its heal check title too) and records `telugu_ok` from it.
- With no remote config and no heals, every provider behaves exactly as today. Today's constants become fallbacks, never deleted.
- Knobs: one env var `RESOLVE_CONFIG_URL` (server), one constant `REMOTE_CONFIG_URL` (APK). Cadences are constants: tick 10 min, healthy 6 h, unhealthy 30 min, blocked/drift 6 h, key-fail streak 3.
- mapple: no server heal, no server canary (APK-only by owner rule).
- The uncommitted routing work (`lib/routing/`, `apiServer.js`, `web/`, `android/` changes listed by `git status`) must be committed by the owner before Tasks 8, 9, 10, 11 and 12 start. Do not edit or stage it before then.
- Git: main, no commit or push. Each task ends with `git add <paths>`; the controller commits.

Test commands:

```
server  node --test test/*.test.js
web     cd web && npx vitest run
apk     export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"; cd android && ./gradlew --no-daemon testReleaseUnitTest
```

## Review Focus

- Precedence: a remote edit of a field must drop an older heal of that field (Task 1, Task 2).
- An empty or broken remote must leave behaviour byte-identical to today (Task 1, Task 5).
- vidrock decrypt with a wrong key must be an error that the classifier calls `key`, not an empty answer (Task 6).
- Classifier must call a Cloudflare challenge `blocked` and must not start a rediscover for it (Task 4, Task 8).
- Canary must never select netmirror or mapple, and must make at most one provider run per tick (Task 7).
- multimovies: no VidBolt host is adopted without a master that has `#EXT-X-MEDIA:TYPE=AUDIO`; the scraper file is read as text, never run (Task 5A).
- vidrift: no host or path is adopted unless the RRR 579974 page has `orionStreams` and a master answers `#EXTM3U`; the shared title-page memo never adopts for the other provider without that provider's own validation (Task 5B).
- `/api/resolve-config` must stay parseable by APK 1.2.40 (`ResolveConfig.kt` ignores unknown keys; `test/resolveConfig.test.js` checks defaults) (Task 3).
- APK with the VM down: config from the remote URL, then cache, then defaults; on-device resolvers unchanged (Task 10).

---

### Task 1: Server config layers

**Files:**
- Create: `lib/selfheal/config.js`
- Test: `test/selfhealConfig.test.js` (create)

**Interfaces:**
- `createConfig({ builtin, url, fetch, now, file })` returns `{ cfg(provider, field, fallback), snapshot(), refresh(), setHeals(map) }`.
- `cfg` precedence: heal > remote > built-in > `fallback`. A wrong-typed value is skipped (string vs array vs object compared to `fallback` type).
- `refresh()`: one GET, 4 s timeout. Parse error, non-2xx, or `version` lower than last good: keep last good. Last good is written to `file` (`data/resolve-config.remote.json`) and read on boot.
- Module default instance: `builtin` = `routes/resolve-config.json`, `url` = `process.env.RESOLVE_CONFIG_URL` (unset = no fetch), ttl = remote `ttlSec` or built-in `ttlSec`.

- [ ] **Step 1: Write failing tests**: (a) no url: `cfg('vidrock','key',K)` returns K; (b) remote has `vidrock.key` R: returns R; (c) heal H over R: returns H; (d) remote changes field to R2: heal dropped, returns R2; (e) remote fetch 500 after a good fetch: last good kept; (f) remote `version` 1 after a good version 2: ignored; (g) `bases` given as a string where fallback is an array: skipped; (h) last good file read on a fresh instance with fetch failing.
- [ ] **Step 2: Run, verify fail**: `node --test test/selfhealConfig.test.js`. Expected: module not found.
- [ ] **Step 3: Implement** with a stubbed `fetch` seam. No timer in this module; the caller schedules `refresh()`.
- [ ] **Step 4: Run, verify pass**: `node --test test/selfhealConfig.test.js`, then `node --test test/*.test.js`.
- [ ] **Step 5: Stage**: `git add lib/selfheal/config.js test/selfhealConfig.test.js`

### Task 2: Heal store (hosts and keys), generalised from upstreamBase

**Files:**
- Modify: `utils/upstreamBase.js:46-91` (`filePath`, `load`, `save`)
- Test: `test/upstreamBase.test.js` (extend), `test/selfhealHeals.test.js` (create)

**Interfaces:**
- File `data/provider-heals.json`: `{ name: { base?: {...today's entry}, fields: { field: { value, how, over, verifiedAt } } } }`.
- `load()` reads `provider-heals.json`; if absent, reads legacy `provider-bases.json` once and maps each entry to `base`.
- New: `setField(name, field, value, how, over)`, `getField(name, field)`, `dropField(name, field)`, `allFields()`. `getBase/withBase/noteOk/noteFail/rediscover` unchanged in signature.
- `UPSTREAM_BASES_FILE` env still honoured (tests use it).

- [ ] **Step 1: Write failing tests**: (a) legacy file only: `getBase` returns its base; (b) `setField` then reload from disk returns it; (c) atomic write: no `.tmp` left; (d) unwritable dir: `setField` returns false, value held in memory, one warning.
- [ ] **Step 2: Run, verify fail**: `node --test test/selfhealHeals.test.js test/upstreamBase.test.js`.
- [ ] **Step 3: Implement**. Wire `config.setHeals(allFields())` on every change (Task 1 interface).
- [ ] **Step 4: Run, verify pass**: same command, then `node --test test/*.test.js`.
- [ ] **Step 5: Stage**: `git add utils/upstreamBase.js test/upstreamBase.test.js test/selfhealHeals.test.js`

### Task 3: `/api/resolve-config` serves the merged view

**Files:**
- Modify: `routes/resolveConfig.js`, `routes/resolve-config.json` (add `castletv`, `multimovies`, `vidrock`, `onetouchtv`, `showsst`, `netmirror.webMirrors`; `version` stays 1 in the built-in file)
- Test: `test/resolveConfig.test.js` (extend)

**Interfaces:**
- `GET /api/resolve-config` returns `snapshot()` from Task 1 (built-in + remote + heals). Same `Cache-Control: public, max-age=300`. 500 only if the snapshot cannot be built.
- Built-in values equal today's provider constants exactly (`castletv.js:8,42`, `multimovies.js:41`, `vidrock.js:39-40`, `onetouchtv.js:9-14`, `showsst.js:44-45`).
- `multimovies`: `bases: ["https://vidbolt.xyz", "https://vidbolt.pro"]` (first equals `multimovies.js:41`; the second is a measured live mirror, tried only when the first fails), `resolvePath`, `sites: ["https://multimovies.wtf"]`, `scrapers: ["https://raw.githubusercontent.com/mayurgj/nama/main/providers/multimovies.js"]`.

- [ ] **Step 1: Write failing tests**: (a) existing A1 tests still pass on the merged output; (b) a heal `vaplayer.wrapperBases` shows in the response; (c) new sections equal the provider constants (read the constants from the modules, not retyped); (d) unknown top-level keys survive.
- [ ] **Step 2: Run, verify fail**: `node --test test/resolveConfig.test.js`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, verify pass**: `node --test test/*.test.js`.
- [ ] **Step 5: Stage**: `git add routes/resolveConfig.js routes/resolve-config.json test/resolveConfig.test.js`

### Task 4: Failure classifier

**Files:**
- Create: `lib/selfheal/classify.js`
- Test: `test/selfhealClassify.test.js` (create)

**Interfaces:**
- `classify({ message, status, body }) -> 'host' | 'key' | 'token' | 'blocked' | 'drift' | 'down'`.
- Rules, first match wins: body or message has `Just a moment` / `cf-mitigated` / `rateLimited:true` -> blocked; `ENOTFOUND|ECONNREFUSED|EAI_AGAIN|certificate` or status 404/410 on a base path -> host; `bad decrypt|Unsupported state or unable to authenticate data|decrypted value is not a URL|JSON` after decrypt -> key; `no apiToken` -> token; timeout or 5xx -> down; anything else -> drift.

- [ ] **Step 1: Write failing tests** using the audit's real strings: mapple `no requestToken (watch 403, session 403: ... Just a moment...)` -> blocked; vaplayer `no apiToken on the player page` -> token; onetouchtv `HTTP 404 from api3.devcorp.me/vod/.../episode/1` -> drift (an episode 404 is not a move; only a base-path 404 is host); `fetch failed ENOTFOUND vidbolt.xyz` -> host; Node GCM auth error -> key; `The operation was aborted due to timeout` -> down.
- [ ] **Step 2: Run, verify fail**: `node --test test/selfhealClassify.test.js`.
- [ ] **Step 3: Implement** as a pure function.
- [ ] **Step 4: Run, verify pass**: `node --test test/*.test.js`.
- [ ] **Step 5: Stage**: `git add lib/selfheal/classify.js test/selfhealClassify.test.js`

### Task 5: Providers read hosts, keys and paths from config; add UPSTREAM

**Files:**
- Modify: `providers/multimovies.js:41,53,277` (origin from `cfg('multimovies','bases')[0]` via `upstream.getBase`, export `UPSTREAM = { name:'multimovies', seed }`, `resolvePath`)
- Modify: `providers/vidrock.js:39-47` (base via `getBase`, key via `cfg/getField`, export `UPSTREAM`)
- Modify: `providers/onetouchtv.js:9-14` (base via `getBase`, key/iv via config, Referer from `front`, export `UPSTREAM`)
- Modify: `providers/castletv.js:42` and the three API version strings (`keySuffix`, `apiVersions` from config)
- Modify: `providers/showsst.js:39-46` (mirrors from config, env first as today)
- Modify: `providers/vaplayer.js:4,24` (`streamDataApiUrl` heal field before `STREAM_API`; `wrapperBases` from config)
- Modify: `providers/netmirror.js:172,214,278` (bootstrap domains and web mirrors: env first, then config list, then today's base64 list). No change to when or how often it requests
- Test: `test/selfhealProviders.test.js` (create)

**Interfaces:**
- Each read happens per call, not at module load, so a config refresh applies without a restart.
- `UPSTREAM.player` for onetouchtv returns its `front` so `rediscover` scans `main.dart.js` (Task 6 adds the scanner).

- [ ] **Step 1: Write failing tests** with stubbed `fetch` capturing URLs: (a) no remote: every provider requests today's exact host (assert URL prefixes); (b) remote `multimovies.bases=['https://x.test']`: request goes to `x.test` with Referer `https://x.test/`; (c) vidrock and onetouchtv export `UPSTREAM`; (d) castle suffix from config changes the derived key; (e) netmirror with a config domain list makes the same NUMBER of discovery requests as today for one resolve (count the stub calls).
- [ ] **Step 2: Run, verify fail**: `node --test test/selfhealProviders.test.js`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, verify pass**: `node --test test/*.test.js` (existing provider tests must stay green unchanged).
- [ ] **Step 5: Stage**: `git add providers/multimovies.js providers/vidrock.js providers/onetouchtv.js providers/castletv.js providers/showsst.js providers/vaplayer.js providers/netmirror.js test/selfhealProviders.test.js`

### Task 5A: multimovies VidBolt discovery chain

Spec: section 5, "multimovies (VidBolt) and vidrift: shared discovery chain"; measured rows multimovies 3-8. Write the title-page fetch so Task 5B can share it: one function returns the parsed page, `vidboltFromTitle` reads from it.

**Files:**
- Create: `lib/selfheal/vidbolt.js`
- Modify: `utils/upstreamBase.js:255-319` (`rediscover` takes `opts.trails`: async functions run in order, lazily, only after every earlier candidate failed verify; each returns `[{ url, how, from }]`)
- Modify: `providers/multimovies.js:277` (`UPSTREAM.trails = vidbolt.trails(cfg)`, `UPSTREAM.verify = vidbolt.validate`)
- Test: `test/selfhealVidbolt.test.js` (create), `test/fixtures/selfheal/mm-title.html`, `test/fixtures/selfheal/nama-mm.js` (create; small synthetic copies of the measured markup, not the real files)

**Interfaces:**
- `currentSite(html)`: most frequent `https?://([a-z0-9-]+\.multimovies\.[a-z]{2,})` origin, or null.
- `titlePath(html)`: `href="(/movie/inception-\d+)"`, or null.
- `vidboltFromTitle(html)`: `const watchConfig = {...}` JSON, `initialServers` entry with `name` `/^vidbolt$/i`, `new URL(url).origin`. Fallback: label-anchored regex `/<button[^>]*data-url="(https?:\/\/[^\/"]+)\/movie\/\d+"[^>]*>(?:(?!<\/button>)[\s\S])*?server-name">\s*vidbolt\s*</i`. Never picks a host by name match on `vidbolt`.
- `fromScraper(text)`: `{ vidbolt, site }` from `/name:\s*"VidBolt",\s*url:\s*"(https?:\/\/[^\/"]+)\/movie\//` and `/var SITE = \{[^}]*base:\s*"(https?:\/\/[^"]+)"/`. Text only; never `eval`, `require` or `Function`.
- `trails(cfg)`: `[titlePageTrail, scraperTrail]`. Title page: GET site, GET `/search?q=inception`, GET title (3 GETs per site). Scraper: 1 GET per URL; its `site` reruns the title-page trail when the landing page failed. `how` = `titlepage` or `scraper`.
- `validate(cand, { fetch })`: https only. GET `${cand}/api/resolve?type=movie&id=27205` with Referer `${cand}/movie/27205`. True only if JSON has a `stream.sources[]` with `kind:"hls"` whose `master` (inline, else one GET of `url`) contains `#EXT-X-MEDIA:TYPE=AUDIO`. Then the provider's own resolve of 27205 must return at least 1 row.
- Caps per run: 3 candidates validated, 12 GETs. Logs `[heal] multimovies candidate <host> via <how>`, `[heal] multimovies reject <host> <reason>`, `[heal] multimovies adopt <host> via <how>`.

- [ ] **Step 1: Write failing tests** with a stubbed `fetch` keyed by URL (no network): (a) `vidbolt.xyz` throws `ENOTFOUND`, `vidbolt.pro` throws, landing names `m9.multimovies.test`, search gives `/movie/inception-8559`, title `watchConfig` names `https://vidbolt.new`, its `/api/resolve` returns an hls source with a master holding `#EXT-X-MEDIA:TYPE=AUDIO`: `rediscover` applies `https://vidbolt.new` with `how:'titlepage'` and the next request goes to it with Referer `https://vidbolt.new/`; (b) landing page dead, scraper text names `https://vidbolt.alt`, validation passes: applied with `how:'scraper'`; (c) scraper `SITE.base` names a new site and the landing page is dead: the title-page trail runs from that site; (d) bad candidate: title page names `https://bad.test` whose `/api/resolve` returns 200 JSON with a master that has no AUDIO line (also: HTML 200, http:// URL): rejected, not applied, `reject` line logged, next candidate tried; (e) label regex fallback: no `watchConfig`, button markup only: host found; a page where only a different server's URL contains `vidbolt`: null; (f) first candidate validates: no scraper GET made (count stub calls); (g) GET count for one full run is 12 or fewer; (h) no remote, all hosts alive: zero trail GETs (behaviour as today).
- [ ] **Step 2: Run, verify fail**: `node --test test/selfhealVidbolt.test.js`. Expected: module not found.
- [ ] **Step 3: Implement** pure parsers first, then the trails, then `opts.trails` in `rediscover`.
- [ ] **Step 4: Run, verify pass**: `node --test test/selfhealVidbolt.test.js test/upstreamBase.test.js`, then `node --test test/*.test.js`. Grep the test log for each `[heal] multimovies` prefix.
- [ ] **Step 5: Stage**: `git add lib/selfheal/vidbolt.js utils/upstreamBase.js providers/multimovies.js test/selfhealVidbolt.test.js test/fixtures/selfheal/mm-title.html test/fixtures/selfheal/nama-mm.js`

### Task 5B: vidrift on the shared title-page trail, and path heals for both

Spec: section 5, "multimovies (VidBolt) and vidrift: shared discovery chain", including "Path change". Needs Task 5A.

**Files:**
- Create: `lib/selfheal/titlePage.js` (move the title-page fetch and `currentSite`/`titlePath` from `lib/selfheal/vidbolt.js`; add the 30-min memo `{ vidbolt, vidrift, site, at }` and `offer(provider, host)`)
- Create: `lib/selfheal/vidrift.js`
- Modify: `lib/selfheal/vidbolt.js` (read the title page through `titlePage.js`; `playerPath` heal)
- Modify: `providers/vidrift.js:50-54,81-86` (bases per call: `VIDRIFT_BASE`, then `getBase('vidrift')` and `cfg('vidrift','bases')`, then today's `BASES`; `moviePath`/`tvPath` from config with today's strings as fallback; export `UPSTREAM = { name:'vidrift', seed, trails, verify }`)
- Modify: `providers/multimovies.js` (`playerPath` from config for Referer)
- Modify: `routes/resolve-config.json` (add `vidrift: { bases, moviePath, tvPath }` with today's values, so `/api/resolve-config` and the Task 13 remote file carry it; old APKs ignore the unknown key)
- Modify: `lib/selfheal/classify.js` (404 on the path while the host root answers, or 2xx without the expected object: `drift`; plain 403 without `cf-mitigated`: `down`)
- Test: `test/selfhealVidrift.test.js` (create), `test/fixtures/selfheal/mm-title.html` (extend: add a `Vidrift` entry to `initialServers`), `test/fixtures/selfheal/vidrift-rrr.html` (create; small synthetic `embedMeta` with 1 orion entry)

**Interfaces:**
- `vidriftFromTitle(page)`: `initialServers` entry with `name` `/^vidrift$/i`, returns `{ origin, path }`. Never matches by host string.
- `pathFromUrl(url, tmdbId)`: path and query with the segment equal to `tmdbId` replaced by `{id}`, or null when no segment equals it.
- `validate(cand, { fetch, moviePath, site })`: https only. GET `${cand}${moviePath('579974')}` with Referer `${site}/`. True only if `embedMeta.orionStreams` is an array with at least 1 entry and one GET of the first master (resolved against `cand`, Vidrift Referer and Origin) returns a body starting with `#EXTM3U`. Then the provider's own resolve of 579974 returns at least 1 row.
- `trails(cfg)`: `[titlePageTrail, scraperSiteTrail]`. The scraper gives `SITE.base` only. `how` = `redirect|config|titlepage|scraper`.
- Caps per run and per provider: 3 candidates validated, 12 GETs. Cooldown 30 min. Logs `[heal] vidrift candidate|reject|adopt <host> ...` and `[heal] vidrift path <tmpl> via titlepage`.

- [ ] **Step 1: Write failing tests** with a stubbed `fetch` keyed by URL (no network): (a) `embed.vidrift.net` and `embed.vidrift.in` throw `ENOTFOUND`, title page names `https://embed.vidrift.new/embed/movie/27205`, its RRR page has `orionStreams` and the master answers `#EXTM3U`: `rediscover` applies `https://embed.vidrift.new` with `how:'titlepage'` and the next page request goes there; (b) `VIDRIFT_BASE` set: it is still tried first after a heal; (c) bad candidates rejected with a `reject` line: `orionStreams` null, empty array, master answers HTML, http:// URL, page with no `embedMeta`; (d) one shared run: a multimovies heal fetches the title page, then a vidrift heal within 30 min makes zero title-page GETs and gets `embed.vidrift.new` as a `titlepage` candidate (count stub calls); (e) the memo never adopts: with vidrift validation failing, vidrift base stays unchanged; (f) path change: host answers `/` 200 but `/embed/movie/579974` 404, title page names `https://embed.vidrift.net/e/movie/27205`: classifier `drift`, `moviePath` saved as `/e/movie/{id}`, base unchanged; (g) title page URL with an IMDb id (`/embed/movie/tt1375666`): `pathFromUrl` null, `reject nopath`, no path saved; (h) multimovies: title page gives `https://vidbolt.xyz/watch/27205`: `playerPath` `/watch/{id}` saved after VidBolt validation; `/api/resolve` 404 on a live host: `drift`, `reject <host> resolvePath`, nothing saved; (i) a remote edit of `vidrift.moviePath` drops the path heal; (j) plain 403 on every vidrift host: `down`, zero trail GETs; with `cf-mitigated`: `blocked`; (k) scraper fixture with no Vidrift entry: zero vidrift host candidates from it, its `SITE.base` still reruns the title-page trail; (l) GET count per provider run is 12 or fewer; (m) no remote, no heal, hosts alive: page URL is `https://embed.vidrift.net/embed/movie/579974`, as today, and `test/vidrift.test.js` passes unchanged.
- [ ] **Step 2: Run, verify fail**: `node --test test/selfhealVidrift.test.js`. Expected: module not found.
- [ ] **Step 3: Implement** `pathFromUrl` and `vidriftFromTitle` first, then `titlePage.js` with the memo, then the validator, then the provider changes.
- [ ] **Step 4: Run, verify pass**: `node --test test/selfhealVidrift.test.js test/selfhealVidbolt.test.js test/vidrift.test.js`, then `node --test test/*.test.js`. Grep the test log for each `[heal] vidrift` prefix.
- [ ] **Step 5: Stage**: `git add lib/selfheal/titlePage.js lib/selfheal/vidrift.js lib/selfheal/vidbolt.js lib/selfheal/classify.js providers/vidrift.js providers/multimovies.js routes/resolve-config.json test/selfhealVidrift.test.js test/fixtures/selfheal/mm-title.html test/fixtures/selfheal/vidrift-rrr.html`

### Task 6: Key and token extractors

**Files:**
- Create: `lib/selfheal/keys.js`
- Modify: `providers/vidrock.js:55-60` (decrypt with `aes-256-gcm` and the tag; throw on auth failure)
- Modify: `providers/vaplayer.js:50-59` (`getApiToken` parses `const CONFIG = {...}` when the regex misses; returns `{ apiToken, streamDataApiUrl, rateLimited }`)
- Test: `test/selfhealKeys.test.js` (create), `test/fixtures/selfheal/` (create small synthetic fixtures; do not commit real site bundles)

**Interfaces:**
- `extractVidrockKey({ fetch, base, sample })`: GET `${base}/movie/27205`, find `/assets/index-*.js`, GET it, collect `"[0-9a-f]{64}"` literals, return the first that GCM-decrypts `sample` with a valid tag. Max 2 GETs.
- `extractOnetouchKey({ fetch, front, sample })`: GET `${front}/main.dart.js`, collect `"[A-Za-z0-9]{32}"` literals, IV = first 16 chars, return the first whose CBC decrypt of `sample` is JSON. Also return API hosts from `="https://api[0-9]*\.[^"]+"` literals. Max 1 GET.
- `parseVaConfig(html)`: returns the CONFIG object or null.
- Trigger: 3 key failures in a row (classifier `key`) on the same provider. Cooldown 30 min (same as `upstreamBase` `COOLDOWN_MS`). Apply via `setField` only after 27205 resolves with the new key.

- [ ] **Step 1: Write failing tests**: (a) synthetic bundle with 2 hex literals, only one valid: correct key returned; (b) no valid literal: null, no apply; (c) onetouch fixture with key inside `mP(){var s="...",r=B.d.a2(s,0,16)`: key and IV returned; (d) `parseVaConfig` on a fixture modelled on the measured page (keys `apiToken`, `streamDataApiUrl`, `rateLimited`) returns them; on `rateLimited:true` the provider throws a message the classifier calls `blocked`; (e) vidrock with a wrong key now throws (not empty).
- [ ] **Step 2: Run, verify fail**: `node --test test/selfhealKeys.test.js`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, verify pass**: `node --test test/*.test.js`.
- [ ] **Step 5: Stage**: `git add lib/selfheal/keys.js providers/vidrock.js providers/vaplayer.js test/selfhealKeys.test.js test/fixtures/selfheal`

### Task 7: Canary loop and `provider_canary` store

**Files:**
- Create: `lib/selfheal/canary.js`
- Modify: `utils/store.js:42` (append one MIGRATIONS entry; JSON backend `empty()` gets `provider_canary: {}`; add `canaryGet/canaryAll/canaryPut`)
- Test: `test/selfhealCanary.test.js` (create)

**Interfaces:**
- `createCanary({ providers, store, classify, heal, recordOutcome, now })` returns `{ tick() }`.
- `tick()`: pick the enabled provider with the oldest `next_due_at` that is due, excluding `netmirror` and `mapple`. Run its resolve on 27205 (plus 784572 for castletv, multimovies, vidrock; vidrift runs 579974 in place of 27205). Pass: `recordOutcome(name,'hit')`, state `ok`, due +6 h. Fail: `classify`, call `heal(kind)` for host/key/token once, re-run 27205 once if applied; state = kind; due +30 min (host, key, token, down) or +6 h (blocked, drift).
- Row columns as in the spec section 6.

- [ ] **Step 1: Write failing tests** with a fake clock and fake providers: (a) one tick runs exactly one provider; (b) netmirror and mapple never chosen even when most overdue; (c) pass resets the breaker (recordOutcome called with 'hit'); (d) blocked failure: no heal call, due +6 h; (e) key failure: heal('key') called once, 27205 re-run once; (f) `telugu_ok` 1 when a Telugu-tagged row comes back for 784572, 0 otherwise; (g) store migration runs on an existing DB at the previous version; (h) vidrift runs 579974 only, never 27205, and `telugu_ok` is 1 when a Telugu-tagged row comes back.
- [ ] **Step 2: Run, verify fail**: `node --test test/selfhealCanary.test.js`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, verify pass**: `node --test test/*.test.js`.
- [ ] **Step 5: Stage**: `git add lib/selfheal/canary.js utils/store.js test/selfhealCanary.test.js`

### Task 8: Wire it in: registry, apiServer, `/api/status`

Waits for the routing work to be committed.

**Files:**
- Modify: `providers/registry.js:92-122` (`noteUpstream`: classify the error; `blocked` and `drift` never call `triggerRediscover`; `key` counts toward the key streak and calls the Task 6 extractor; verify uses both 27205 and the provider's resolve as today)
- Modify: `apiServer.js` (boot: `config.refresh()` and a refresh timer every `ttlSec`, `unref()`; canary `setInterval(tick, 10 min).unref()`; `/api/status` adds `heal: {state, kind, lastOkAt, lastRunAt, teluguOk, healHow}` per provider; skip a provider for non-web callers when its canary state is `blocked` and the config route says `apk: device`)
- Test: `test/providerRegistry.test.js` (extend), `test/selfhealWiring.test.js` (create)

- [ ] **Step 1: Write failing tests**: (a) 5 mapple failures with a Cloudflare body: zero rediscover calls; (b) 5 vidrock host errors: one rediscover; (c) `/api/status` has `heal` for each provider with a row; (d) blocked vaplayer with `apk: device` is not run for a default caller; (e) a canary pass on that provider lets it run again; (f) 5 multimovies `ENOTFOUND vidbolt.xyz` errors: one rediscover, called with `UPSTREAM.trails` and `UPSTREAM.verify` from Task 5A; (g) 5 vidrift `ENOTFOUND embed.vidrift.net` errors: one rediscover with the Task 5B trails and verify.
- [ ] **Step 2: Run, verify fail**: `node --test test/selfhealWiring.test.js test/providerRegistry.test.js`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, verify pass**: `node --test test/*.test.js` and `cd web && npx vitest run` (web reads `/api/status`).
- [ ] **Step 5: Stage**: `git add providers/registry.js apiServer.js test/providerRegistry.test.js test/selfhealWiring.test.js`

### Task 9: Routes from config

Waits for the routing work to be committed. Needs owner answer on vocabulary (spec open question 4).

**Files:**
- Modify: `lib/routing/providerRoutes.js` (`routeFor` and `surfaceAllows` read `cfg('routes', provider)` first; today's `PROVIDER_ROUTES`/`PROVIDER_SURFACES` stay as the built-in default; map `off`->`none`, `device`->`on-device`; `hostPatterns[].re` accepted as string)
- Test: `test/providerRoutes.test.js`, `test/providerSurfaces.test.js` (extend)

- [ ] **Step 1: Write failing tests**: (a) no remote: every existing assertion unchanged; (b) remote `vidrock: {web:'direct', apk:'direct'}` gives `routeFor('vidrock', url)` direct; (c) remote `castletv: {web:'off'}` makes `surfaceAllows('castletv','web')` false; (d) invalid value (`'fast'`) falls back to built-in.
- [ ] **Step 2: Run, verify fail**: `node --test test/providerRoutes.test.js test/providerSurfaces.test.js`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, verify pass**: `node --test test/*.test.js`, `cd web && npx vitest run`.
- [ ] **Step 5: Stage**: `git add lib/routing/providerRoutes.js test/providerRoutes.test.js test/providerSurfaces.test.js`

### Task 10: APK config: new sections and remote fallback

Waits for the routing work to be committed.

**Files:**
- Modify: `android/app/src/main/java/com/chitram/app/resolve/ResolveConfig.kt` (add `CastleConfig(bases, keySuffix)`, `MultiMoviesConfig(bases, resolvePath)`, `routes` map of `apk` values; `ResolveConfigStore` takes `urls: List<String>`: VM path first, `REMOTE_CONFIG_URL` second; skip the VM url when `vmUp` is false)
- Modify: `android/app/src/main/java/com/chitram/app/App.kt:58` (pass both urls and a `vmUp` supplier)
- Test: `android/app/src/test/java/com/chitram/app/ResolveConfigTest.kt` (create)

- [ ] **Step 1: Write failing tests** with MockWebServer or the existing fake `KeyValue`/HTTP seams used by `OnDeviceResolveTest.kt`: (a) VM 500, remote 200: remote config used and cached; (b) both fail: last cached copy; (c) nothing ever: defaults; (d) `vmUp=false`: VM url not requested; (e) a doc with only old sections parses with new defaults equal to `CastleResolver.BASE` and `MultiMoviesResolver.ORIGIN`; (f) a VM doc with `multimovies.bases: ["https://vidbolt.new", "https://vidbolt.xyz"]` (a VM heal first) parses in that order.
- [ ] **Step 2: Run, verify fail**: the APK test command.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, verify pass**: the APK test command.
- [ ] **Step 5: Stage**: `git add android/app/src/main/java/com/chitram/app/resolve/ResolveConfig.kt android/app/src/main/java/com/chitram/app/App.kt android/app/src/test/java/com/chitram/app/ResolveConfigTest.kt`

### Task 11: APK Castle and MultiMovies on HostBook

**Files:**
- Modify: `android/app/src/main/java/com/chitram/app/resolve/CastleResolver.kt:39-46,159,186` (base from `HostBook.heal(castletv.bases)`, suffix from config)
- Modify: `android/app/src/main/java/com/chitram/app/resolve/MultiMoviesResolver.kt:20-33,66` (origin from `HostBook.heal(multimovies.bases)`, `resolvePath`)
- Modify: `android/app/src/main/java/com/chitram/app/resolve/OnDevice.kt` and `App.kt:63-64` (pass config and HostBook)
- Test: `android/app/src/test/java/com/chitram/app/OnDeviceResolveTest.kt` (extend)

- [ ] **Step 1: Write failing tests**: (a) first base dead, second answers: second used and remembered; (b) first base 301 to another origin: `Moved` followed; (c) default config: same URLs as today; (d) MultiMovies: config `bases` = [VM-healed `https://vidbolt.new`, `https://vidbolt.xyz`], `vidbolt.xyz` dead: `vidbolt.new` used with Referer/Origin from it, no request to multimovies sites or the scraper URL; (e) MultiMovies probe: a base whose `/api/resolve` has no source with `#EXT-X-MEDIA:TYPE=AUDIO` in `master` is `Dead`, not remembered.
- [ ] **Step 2: Run, verify fail**: the APK test command.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, verify pass**: the APK test command.
- [ ] **Step 5: Stage**: `git add android/app/src/main/java/com/chitram/app/resolve/CastleResolver.kt android/app/src/main/java/com/chitram/app/resolve/MultiMoviesResolver.kt android/app/src/main/java/com/chitram/app/resolve/OnDevice.kt android/app/src/main/java/com/chitram/app/App.kt android/app/src/test/java/com/chitram/app/OnDeviceResolveTest.kt`

### Task 12: APK VaPlayer CONFIG fallback

**Files:**
- Modify: `android/app/src/main/java/com/chitram/app/resolve/VaplayerResolver.kt:56` (regex miss: parse `const CONFIG = {...}`; use `apiToken`, and `streamDataApiUrl` over `cfg.apiUrl`; `rateLimited:true` throws `StepException("vaplayer", 429, "rateLimited")` so the breaker backs off)
- Test: `android/app/src/test/java/com/chitram/app/VaplayerConfigTest.kt` (create)

- [ ] **Step 1: Write failing tests**: (a) regex matches: unchanged path; (b) regex set to a non-matching pattern, CONFIG present: token from CONFIG; (c) `streamDataApiUrl` differs from `cfg.apiUrl`: CONFIG wins; (d) `rateLimited:true`: StepException 429.
- [ ] **Step 2: Run, verify fail**: the APK test command.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, verify pass**: the APK test command.
- [ ] **Step 5: Stage**: `git add android/app/src/main/java/com/chitram/app/resolve/VaplayerResolver.kt android/app/src/test/java/com/chitram/app/VaplayerConfigTest.kt`

### Task 13: Host the remote file, deploy, one live check

Needs owner answer on hosting (spec open question 1) and a deploy go.

- [ ] **Step 1**: Create the remote JSON from `GET /api/resolve-config` built-in output with `version: 2`. Owner picks the host. Record the raw URL.
- [ ] **Step 2**: Set `RESOLVE_CONFIG_URL` in the VM `.env`; set `REMOTE_CONFIG_URL` in the APK. Full suites green: server, web, APK commands above.
- [ ] **Step 3**: Deploy with `scripts/deploy-vm.sh` (owner go). Confirm `data/` is writable on the VM: `ls -ld /root/tmdb-embed-api/data`.
- [ ] **Step 4**: Wait one canary cycle. Read `curl -s https://tmdb-187-127-137-163.sslip.io/api/status` and record each provider's `heal` row. Expected: mapple absent (not run), netmirror absent, vaplayer `blocked` or `ok`, vidrift row present with `telugu_ok` from RRR 579974. Grep `~/.pm2/logs/tmdb-embed-api-out.log` for `[canary]` lines; count netmirror canary lines (must be 0).
- [ ] **Step 5**: One remote edit test: change a harmless field (`ttlSec`), wait `ttlSec`, confirm `/api/resolve-config` shows it. Revert.
- [ ] **Step 6**: APK: install the build, play one Telugu title (Krack 784572) with the VM reachable, then with the VM url blocked on the device network; confirm config log `resolve-config: fetched` from the remote URL and an on-device source plays.
- [ ] **Step 7**: Label each result `verified` with the pasted output or `unverified` with the reason.
