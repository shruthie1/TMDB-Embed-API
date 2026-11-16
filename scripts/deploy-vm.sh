#!/usr/bin/env bash
# Deploy the API (apiServer.js) to VM1 from git HEAD, with automatic rollback.
#
#   SSHPASS='<vm root password>' scripts/deploy-vm.sh            # deploy HEAD
#   SSHPASS='<vm root password>' scripts/deploy-vm.sh --dry-run  # build + upload + checks, no swap
#
# What it does:
#   1. git archive HEAD (no web/, no tests, no screenshots; secrets are never tracked).
#   2. Uploads it to VM1 and stages it in a COPY of the live dir, so .env,
#      utils/user-config.json, ADMIN_PASSWORD and node_modules carry over.
#      Code files removed in git are removed from the stage.
#   3. npm ci only when package-lock.json changed. `node --check` on every file.
#   4. Backs up the live dir, swaps the stage in, restarts ONLY the PM2 app
#      tmdb-embed-api (never `pm2 save`: that would rewrite the fleet's dump).
#   5. Health-checks 127.0.0.1:8787 and the public https origin. On failure it
#      swaps the previous dir back, restarts, and exits non-zero.
#
# The password is read from $SSHPASS only (sshpass -e). Never pass it as an
# argument or write it to a file.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@187.127.137.163}"
DIR="${DEPLOY_DIR:-/root/tmdb-embed-api}"
APP="${DEPLOY_APP:-tmdb-embed-api}"
LOCAL_HEALTH="${DEPLOY_LOCAL_HEALTH:-http://127.0.0.1:8787/api/health}"
PUBLIC_HEALTH="${DEPLOY_PUBLIC_HEALTH:-https://tmdb-187-127-137-163.sslip.io/api/health}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ -z "${SSHPASS:-}" ]; then
  echo "SSHPASS is not set. Export the VM password in SSHPASS and re-run." >&2
  exit 2
fi
command -v sshpass >/dev/null || { echo "sshpass missing: brew install hudochenkov/sshpass/sshpass" >&2; exit 2; }

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
SHA="$(git rev-parse --short=12 HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "note: working tree has uncommitted changes; deploying committed HEAD $SHA only"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$TMP/tmdb-embed-api-$SHA.tgz"
git archive --format=tar.gz -o "$TARBALL" HEAD -- . \
  ':(exclude)web' ':(exclude)test' ':(exclude)screenshots' ':(exclude)api' \
  ':(exclude).env' ':(exclude)utils/user-config.json'
if tar tzf "$TARBALL" | grep -E '(^|/)\.env$|^utils/user-config\.json$|^web/' >/dev/null; then
  echo "refusing: archive contains web/ or a secrets file" >&2; exit 3
fi
echo "built $(du -h "$TARBALL" | cut -f1) archive of $SHA"

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=25)
REMOTE_TGZ="/root/tmdb-embed-api-releases/$SHA.tgz"
sshpass -e ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p /root/tmdb-embed-api-releases /root/tmdb-embed-api-backups"
sshpass -e scp "${SSH_OPTS[@]}" "$TARBALL" "$HOST:$REMOTE_TGZ"
echo "uploaded to $HOST:$REMOTE_TGZ"

# Everything below runs on the VM in one bash, with values passed as argv.
sshpass -e ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- \
  "$DIR" "$APP" "$REMOTE_TGZ" "$SHA" "$LOCAL_HEALTH" "$PUBLIC_HEALTH" "$DRY_RUN" <<'REMOTE'
set -euo pipefail
DIR="$1"; APP="$2"; TGZ="$3"; SHA="$4"; LOCAL_HEALTH="$5"; PUBLIC_HEALTH="$6"; DRY_RUN="$7"
TS="$(date -u +%Y%m%d-%H%M%S)"
STAGE="$DIR.stage-$SHA"
PREV="$DIR.prev-$TS"
BACKUP="/root/tmdb-embed-api-backups/$TS.tgz"

pm2 describe "$APP" >/dev/null || { echo "pm2 app $APP not found; not deploying" >&2; exit 4; }

echo "[vm] backup $DIR -> $BACKUP (without node_modules)"
tar czf "$BACKUP" --exclude=node_modules -C "$(dirname "$DIR")" "$(basename "$DIR")"

echo "[vm] stage in $STAGE"
rm -rf "$STAGE"
cp -a "$DIR" "$STAGE"
LIST="$(mktemp)"
tar tzf "$TGZ" | sed 's|/$||' > "$LIST"
tar xzf "$TGZ" -C "$STAGE"
# Code files deleted in git must not linger in the stage. Runtime files that
# git never tracks (.env, user-config.json, ADMIN_PASSWORD, caches) are kept.
( cd "$STAGE" && find apiServer.js providers lib routes proxy utils public -type f \
    \( -name '*.js' -o -name '*.mjs' -o -name '*.html' -o -name '*.css' \) 2>/dev/null ) | while read -r f; do
  grep -qxF "$f" "$LIST" || { echo "[vm] removing $f (not in $SHA)"; rm -f "$STAGE/$f"; }
done
rm -f "$LIST"

if ! cmp -s "$DIR/package-lock.json" "$STAGE/package-lock.json"; then
  echo "[vm] package-lock.json changed: npm ci --omit=dev"
  ( cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund )
fi

echo "[vm] node --check"
( cd "$STAGE" && find apiServer.js providers lib routes proxy utils -name '*.js' -print0 \
    | xargs -0 -n1 node --check )
( cd "$STAGE" && node -e "require('./utils/config')" )

if [ "$DRY_RUN" = "1" ]; then
  echo "[vm] dry run: stage $STAGE passes checks; live dir untouched"
  rm -rf "$STAGE"
  exit 0
fi

health() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 5 "$LOCAL_HEALTH" | grep -q '"ok":true'; then return 0; fi
    sleep 1
  done
  return 1
}
restarts() { pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s).find(p=>p.name===process.argv[1]);console.log(a?a.pm2_env.restart_time:-1)})" "$APP"; }

echo "[vm] swap: $DIR -> $PREV, $STAGE -> $DIR"
mv "$DIR" "$PREV"
mv "$STAGE" "$DIR"
pm2 restart "$APP" --kill-timeout 10000 --update-env >/dev/null
sleep 3
R0="$(restarts)"
if health && sleep 10 && [ "$(restarts)" = "$R0" ] && health \
   && curl -fsS --max-time 10 "$PUBLIC_HEALTH" | grep -q '"ok":true'; then
  echo "[vm] healthy on $SHA. previous dir kept at $PREV, backup at $BACKUP"
  curl -fsS --max-time 5 "$LOCAL_HEALTH"; echo
  exit 0
fi

echo "[vm] UNHEALTHY on $SHA: rolling back" >&2
pm2 logs "$APP" --lines 40 --nostream 2>&1 | tail -40 >&2 || true
rm -rf "$DIR.failed-$SHA"
mv "$DIR" "$DIR.failed-$SHA"
mv "$PREV" "$DIR"
pm2 restart "$APP" --kill-timeout 10000 --update-env >/dev/null
if health; then echo "[vm] rolled back; previous build is serving" >&2; else echo "[vm] ROLLBACK ALSO UNHEALTHY: restore from $BACKUP" >&2; fi
exit 5
REMOTE
