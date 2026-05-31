#!/usr/bin/env bash
# Deprecated: use setup-direnv.sh (direnv + .envrc).
set -euo pipefail
echo "setup-auto-nvm-use.sh is deprecated; running setup-direnv.sh ..." >&2
exec "$(cd "$(dirname "$0")" && pwd)/setup-direnv.sh" "$@"
