# MultiMovies verification — 2026-11-24

Local checks completed. Nothing deployed or installed by Codex in this pass.

## Reviewed changes

- Published address changes require known title links, media bytes and runtime proof on two titles. Each checked service must itself name the requested movie or exact episode. Runtime proof rejects short clips and excessively long media.
- Publication protects concurrent configuration edits, supports rollback, and stops after cancellation. Catalog caches are isolated by host/parser configuration; Android leases protect requests and cache writes from obsolete configuration.
- Cineverse/GD/Nexus are registered API providers; website and Android metadata group their rows under MultiMovies. Native device resolvers for these three services are not implemented in this change; those rows currently require the API.
- Linked-source discovery preserves resolved rows as partial when its deadline expires. Explicit caller cancellation still propagates. Regression tests cover the next lookup and prevent requests after cancellation.

## Executed checks

- API: 968 passed, 0 failed (`/tmp/chitram-reviewed-api-tests.log`).
- Website: 1,338 passed across 136 files (`/tmp/chitram-web-verification.log`).
- Website production build succeeded in isolated `.next-codex-final` output (`/tmp/chitram-web-final-build.log`).
- Website lint: 0 errors, 2 hook dependency warnings in Player.jsx.
- Android unit tests/build succeeded with OpenJDK 17: 754 tests, 0 failures/errors, 6 skipped (748 passed); debug APK assembled. Gradle reused current successful unit-test outputs (`/tmp/chitram-android-final-verification.log`).
- `git diff --check` passed before this documentation-only addition.

## Bounded live extraction checks: RRR, TMDB 579974

- Cineverse: 1 row in 7.745 seconds; language untagged.
- GD mirror before the fix: Insertunit resolved Russian/Telugu/Hindi, but a later deadline discarded the rows.
- GD mirror after the fix: 10 rows in 16.168 seconds, partial=true; tagged Russian/Telugu/Hindi/English/Bengali retained. Some linked services remained pending or failed.
- Nexus: upstream quota response in 1.496 seconds. No retry or workaround.

These checks prove extraction, not rendered playback or actual speech.

## Remaining release verification

- Rendered playback/audio switching/TV casting for newly integrated services.
- Native direct device implementations for Cineverse/GD/Nexus for full device-first parity.
- Requested before/after 30-title Telugu comparison; not executed in this pass.
- Real production address migration/rollback, configured alert delivery and restart survival.
- No deployment, APK installation, commit or push performed by Codex. Claude was actively testing the phone, so Codex did not interfere.
