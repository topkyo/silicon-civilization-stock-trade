#!/usr/bin/env bash
# Clear pyserver SQLite market cache (removes stale mock-era rows) and restart sidecar.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CACHE="${REPO_ROOT}/pyserver/cache.db"
DOMAIN="gui/$(id -u)"
LABEL="com.topkyo.ai-infra.pyserver"

if launchctl print "${DOMAIN}/${LABEL}" &>/dev/null; then
  echo "stopping ${LABEL}..."
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  sleep 1
fi

if [[ -f "${CACHE}" ]]; then
  rm -f "${CACHE}"
  echo "removed ${CACHE}"
else
  echo "no cache.db (already clean)"
fi

PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
if [[ -f "${PLIST}" ]]; then
  launchctl bootstrap "${DOMAIN}" "${PLIST}" 2>/dev/null || true
  launchctl kickstart -k "${DOMAIN}/${LABEL}"
  sleep 3
  curl -sf http://127.0.0.1:8001/health && echo "pyserver: ok" || echo "pyserver: not ready — see ~/Library/Logs/topkyo-ai-infra/"
else
  echo "plist missing — run scripts/macos/install-launchd.sh first"
  exit 1
fi

echo ""
echo "Browser: DevTools → Application → Local Storage → delete keys:"
echo "  silicon-civ:spot:v1"
echo "  silicon-civ:analyst:v1"
