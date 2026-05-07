#!/usr/bin/env bash
# Kill any running browser-print-shim.py instances and start a fresh one in
# the foreground. Ctrl-C to stop. Any flags are passed through to the shim.
# Run from the repo root:
#
#   ./utils/restart-shim.sh
#   ./utils/restart-shim.sh --network 192.168.1.42
#   ./utils/restart-shim.sh --https
#
# Tip: in another terminal, serve the page from the repo root with
# `python3 -m http.server 8000 -d app`, then open
# http://localhost:8000/browser-print.html.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if pgrep -f browser-print-shim.py >/dev/null 2>&1; then
  echo "Stopping existing shim…"
  pkill -f browser-print-shim.py
  # Give the OS a moment to release ports 9100/9101.
  sleep 0.5
fi

echo "Starting shim. Ctrl-C to stop."
exec python3 browser-print-shim.py "$@"
