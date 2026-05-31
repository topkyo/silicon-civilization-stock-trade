#!/usr/bin/env bash
# Rebuild better-sqlite3 for the Node version resolved from .nvmrc.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/resolve-node.sh
source "${SCRIPT_DIR}/resolve-node.sh"

NODE_BIN="$(resolve_node_bin)"
NPM_BIN="$(dirname "${NODE_BIN}")/npm"
WEB_DIR="${REPO_ROOT}/web"
SQLITE_DIR="${WEB_DIR}/node_modules/better-sqlite3"

if [[ ! -d "${SQLITE_DIR}" ]]; then
  echo "skip: ${SQLITE_DIR} not found (run npm install in web/ first)" >&2
  exit 0
fi

echo "rebuilding better-sqlite3 for $("${NODE_BIN}" -v) (${NODE_BIN})..."
export PATH="$(dirname "${NODE_BIN}"):/usr/bin:/bin"
cd "${SQLITE_DIR}"
rm -rf build
"${NPM_BIN}" run build-release
echo "better-sqlite3: ok"
