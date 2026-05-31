#!/usr/bin/env bash
# One-shot: install direnv, enable shell hook, allow this repo's .envrc.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAZY_NVM="${HOME}/.config/shell/lazy-nvm.zsh"
DIRENV_SH="${HOME}/.config/shell/direnv.sh"
ZSHRC="${HOME}/.zshrc"
OLD_MARKER="# topkyo-ai-infra-dashboard: nvm auto-use"

if ! command -v brew >/dev/null 2>&1; then
  echo "error: Homebrew required to install direnv" >&2
  exit 1
fi

if ! command -v direnv >/dev/null 2>&1; then
  brew install direnv
else
  echo "direnv already installed: $(command -v direnv)"
fi

if [[ -f "${LAZY_NVM}" ]] && grep -qF "${OLD_MARKER}" "${LAZY_NVM}"; then
  grep -vF "${OLD_MARKER}" "${LAZY_NVM}" | grep -vF 'nvm-auto-use.zsh' >"${LAZY_NVM}.tmp"
  mv "${LAZY_NVM}.tmp" "${LAZY_NVM}"
  echo "removed legacy nvm-auto-use lines from ${LAZY_NVM}"
fi

if [[ ! -f "${DIRENV_SH}" ]]; then
  echo "error: missing ${DIRENV_SH}; add direnv to ~/.zshrc module loop" >&2
  exit 1
fi

if ! grep -qE '(^|[[:space:]])direnv([[:space:]]|$)' "${ZSHRC}" 2>/dev/null; then
  echo "warn: ${ZSHRC} may not load direnv.sh (expected 'direnv' in module list)" >&2
fi

(cd "${REPO_ROOT}" && direnv allow .)

echo ""
echo "Configured. Open a new terminal tab, then:"
echo "  cd ${REPO_ROOT}"
echo "  node -v    # should match .nvmrc ($(tr -d '[:space:]' < "${REPO_ROOT}/.nvmrc" | sed 's/^v//')) via nvm use in .envrc"
echo ""
echo "Check: direnv status"
