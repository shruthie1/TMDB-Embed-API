# MultiMovies reliability follow-up

Implemented locally on 2026-11-24. Not committed, deployed, or installed.

## Scope

The MultiMovies catalog address remains manually configured. No GitHub-list
tracking or automatic catalog-address propagation was added. Existing verified
player-host recovery remains intact, including its threshold for repeated
transport failures; a single timeout does not automatically switch hosts.

## Root causes and affected paths

- Nexus recognized some quota text but missed Cloudflare error 1027, accepted
  only numeric Retry-After, and capped even explicit longer cooldowns. Shared
  classification now distinguishes hosting quota from host moves and honors
  both seconds and HTTP dates. Nexus applies cooldown before subsequent token
  and catalog requests. A missing retry instruction defaults to one hour for
  quota and fifteen minutes for rate limiting.
- Nexus discarded collected manifests when a later candidate threw. It now
  keeps tagged rows, marks them incomplete and stops on quota/deadline. Ordinary
  candidate failures permit trying the next manifest.
- GD directory/helper failures could discard published fallback links or
  already-discovered mirrors. Available links survive as partial, quota stops
  further helper requests, and caller cancellation still propagates.
- Mirror wrappers dropped child partial markers and discarded collected rows
  on errors other than deadline. Markers now survive child wrapping; collected
  rows survive later failures. Explicit cancellation stops further steps.
- Registry host-failure counts previously included quota/blocked/5xx errors
  before checking whether rediscovery was appropriate. They no longer seed a
  subsequent host-recovery trigger.
- Both health-check consumers were audited. Incomplete language discovery and
  failed requests no longer erase a previous Telugu baseline. A complete
  successful response can still update the baseline, and a subsequent healthy
  run restores health normally.

## Verification

- Reproduced four new failures before applying fixes: Cloudflare quota/date
  cooldown, lost Nexus manifests, dropped child partial marker, and lost rows
  after a linked-page quota response.
- Final complete API suite: **974 passed, 0 failed** in 17.3 seconds.
  Log: `/tmp/chitram-reliability-final-all.log`.
- Coverage includes registry normalization, aggregate and per-provider HTTP
  responses, incomplete-result no-store/cache behavior, single-flight reuse,
  quota expiry/recovery, explicit cancellation, no-next-request checks, and
  both health-check loops' Telugu baseline/recovery behavior.
- No new live Nexus extraction was attempted during this change; its previous
  observed failure was Cloudflare 1027 (site owner plan limit). Tests simulate
  its response; successful Nexus playback remains unverified.
- No website or Android player code was changed in this follow-up. Claude's
  concurrent Android edits were left untouched.
