#!/usr/bin/env bash
# Prepares trialuser/vidaa-appstore to install Chitram on a Hisense VIDAA TV.
# It does NOT start any server. It prints the command to start it.
#
#   ./setup.sh            # uses the Wi-Fi IP of this Mac (en0)
#   ./setup.sh 192.168.1.20
set -euo pipefail

REPO=https://github.com/trialuser/vidaa-appstore.git
PIN=8c61a326323e6cc2a5f356c036d41ab6515da053   # main, 2024-10-07
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HERE/.work/vidaa-appstore"

MAC_IP="${1:-$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || true)}"
if [[ -z "$MAC_IP" ]]; then
  echo "No Wi-Fi IP found. Pass it: ./setup.sh 192.168.x.y" >&2; exit 1
fi

# The tool's DNS server answers ONLY the names it lists and returns NXDOMAIN for
# the rest, so the hosts the install page needs are pinned to today's IPs.
resolve() { dig +short "$1" A @1.1.1.1 | grep -E '^[0-9.]+$' | head -1; }
AJAX_IP="$(resolve ajax.googleapis.com)"
RAW_IP="$(resolve raw.githubusercontent.com)"
[[ -n "$AJAX_IP" && -n "$RAW_IP" ]] || { echo "DNS lookup failed. Are you online?" >&2; exit 1; }

if [[ ! -d "$WORK/.git" ]]; then
  mkdir -p "$HERE/.work"
  git clone --quiet "$REPO" "$WORK"
fi
git -C "$WORK" fetch --quiet origin
git -C "$WORK" checkout --quiet --force "$PIN"

# A fresh certificate. The repo ships its own private key, which everyone has.
mkdir -p "$WORK/ssl"
if [[ ! -f "$WORK/ssl/local.key" ]]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 30 -nodes \
    -keyout "$WORK/ssl/local.key" -out "$WORK/ssl/local.crt" \
    -subj "/CN=vidaahub.com" -addext "subjectAltName=DNS:vidaahub.com" 2>/dev/null
fi

# config.json and an install page that lists only Chitram.
python3 -I - "$HERE" "$WORK" "$MAC_IP" "$AJAX_IP" "$RAW_IP" <<'PY'
import json, re, sys
here, work, mac, ajax, raw = sys.argv[1:6]
cfg = open(f"{here}/config.template.json").read()
cfg = cfg.replace("__MAC_IP__", mac).replace("__AJAX_IP__", ajax).replace("__RAW_IP__", raw)
json.loads(cfg)                                   # must parse
open(f"{work}/config.json", "w").write(cfg)

app = json.load(open(f"{here}/chitram-app.json"))
src = open(f"{work}/index-en.html", encoding="utf-8").read()
new, n = re.subn(r"var apps = \[.*?\n\];", lambda m: "var apps = [\n\t" + json.dumps(app) + "\n];",
                 src, count=1, flags=re.S)
if n != 1 or "function installHisense" not in new:
    sys.exit("index-en.html layout changed; check the pinned commit")
open(f"{work}/index-chitram.html", "w", encoding="utf-8").write(new)
print(f"config.json and index-chitram.html written (Mac IP {mac})")
PY

if [[ ! -x "$WORK/.venv/bin/python" ]]; then
  python3 -m venv "$WORK/.venv"
  "$WORK/.venv/bin/pip" install --quiet dnslib
fi

cat <<MSG

Ready. Set the TV's DNS to: $MAC_IP

Start the installer (needs sudo for ports 53 and 443; Ctrl+C stops it):
  cd "$WORK" && sudo .venv/bin/python server.py
MSG
