#!/usr/bin/env bash
# Resolve NODE_BIN from NODE_BIN env, repo .nvmrc, or PATH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_node_bin() {
  if [[ -n "${NODE_BIN:-}" ]] && [[ -x "${NODE_BIN}" ]]; then
    echo "${NODE_BIN}"
    return 0
  fi

  local nvmrc="${REPO_ROOT}/.nvmrc"
  if [[ -f "${nvmrc}" ]]; then
    local ver
    ver="$(tr -d '[:space:]' < "${nvmrc}")"
    ver="${ver#v}"
    local candidate="${HOME}/.nvm/versions/node/v${ver}/bin/node"
    if [[ -x "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
    echo "error: .nvmrc requires Node v${ver}; install with: nvm install ${ver}" >&2
    return 1
  fi

  local fallback
  fallback="$(command -v node 2>/dev/null || true)"
  if [[ -n "${fallback}" ]] && [[ -x "${fallback}" ]]; then
    echo "${fallback}"
    return 0
  fi

  echo "error: node not found (set NODE_BIN or add .nvmrc + nvm install)" >&2
  return 1
}
