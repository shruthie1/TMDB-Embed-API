#!/usr/bin/env bash
# Signed release build. The keystore is outside the repo; its password lives in
# the macOS Keychain (service chitram-apk-sign) and is never printed.
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export CHITRAM_KEYSTORE="${CHITRAM_KEYSTORE:-$HOME/Documents/Projects/local/chitram-android/release.jks}"
CHITRAM_KS_PASS="$(security find-generic-password -s chitram-apk-sign -w)"
export CHITRAM_KS_PASS
# One APK for phone and TV: square icon + wide banner serve both (the Fire TV
# launcher draws the banner, not the icon).
./gradlew --no-daemon testReleaseUnitTest assembleRelease "$@"
version="$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' app/build.gradle.kts)"
out="$HOME/Documents/Projects/local/chitram-android/Chitram-${version}.apk"
cp app/build/outputs/apk/release/app-release.apk "$out"
echo "APK: $out ($(stat -f %z "$out") bytes)"
