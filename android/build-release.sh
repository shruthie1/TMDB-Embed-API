#!/usr/bin/env bash
# Signed release build. The keystore is outside the repo; its password lives in
# the macOS Keychain (service chitram-apk-sign) and is never printed.
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export CHITRAM_KEYSTORE="${CHITRAM_KEYSTORE:-$HOME/Documents/Projects/local/chitram-android/release.jks}"
CHITRAM_KS_PASS="$(security find-generic-password -s chitram-apk-sign -w)"
export CHITRAM_KS_PASS
# One APK for phone and TV. The Fire OS 6 home row draws the Appstore's copy of
# mipmap/ic_launcher, not the banner. FireTvIconTest guards those resources.
# After `adb install -r` the Appstore deletes that copy (its PACKAGE_REPLACED bug),
# so the tile goes blank. Repair: see firetv-icon-rca.md in .superpowers/sdd.
./gradlew --no-daemon testReleaseUnitTest assembleRelease "$@"
version="$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' app/build.gradle.kts)"
out="$HOME/Documents/Projects/local/chitram-android/Chitram-${version}.apk"
cp app/build/outputs/apk/release/app-release.apk "$out"
echo "APK: $out ($(stat -f %z "$out") bytes)"
