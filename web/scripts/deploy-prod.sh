#!/usr/bin/env bash
set -euo pipefail

PROJECT="${VERCEL_PROJECT:-chtrm}"
SCOPE="${VERCEL_SCOPE:-team_TMU8z8GZooAlE2xBo8V7FDjY}"
ALIAS="${VERCEL_ALIAS:-chtrm.vercel.app}"

args=(--prod --yes --scope "$SCOPE" --project "$PROJECT" --json)
[[ -n "${VERCEL_TOKEN:-}" ]] && args+=(--token "$VERCEL_TOKEN")

json="$(vercel "${args[@]}")"
deployment="$(printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", c => { s += c; });
process.stdin.on("end", () => {
  const d = JSON.parse(s);
  const u = d.deployment?.url || d.url;
  if (!u) process.exit(1);
  process.stdout.write(/^https?:\/\//.test(u) ? u : `https://${u}`);
});
')"

alias_args=(alias set "$deployment" "$ALIAS" --scope "$SCOPE")
[[ -n "${VERCEL_TOKEN:-}" ]] && alias_args+=(--token "$VERCEL_TOKEN")
vercel "${alias_args[@]}"

printf 'Production: %s\nStable URL: https://%s\n' "$deployment" "$ALIAS"
