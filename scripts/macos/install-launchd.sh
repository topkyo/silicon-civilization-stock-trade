#!/usr/bin/env bash
# Install topkyo AI infra dashboard as user LaunchAgents (login auto-start).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AGENTS_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/Library/Logs/topkyo-ai-infra"

UV_BIN="${UV_BIN:-$(command -v uv 2>/dev/null || echo "${HOME}/.local/bin/uv")}"
if [[ -z "${NODE_BIN:-}" ]]; then
  NODE_BIN="$(ls -1 "${HOME}/.nvm/versions/node/"*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
NPM_BIN="$(dirname "${NODE_BIN}")/npm"

if [[ ! -x "${UV_BIN}" ]]; then
  echo "error: uv not found (set UV_BIN)" >&2
  exit 1
fi
if [[ ! -x "${NODE_BIN}" ]] || [[ ! -x "${NPM_BIN}" ]]; then
  echo "error: node/npm not found (set NODE_BIN)" >&2
  exit 1
fi

mkdir -p "${AGENTS_DIR}" "${LOG_DIR}"

write_plist() {
  local label="$1"
  local workdir="$2"
  shift 2
  local -a args=("$@")
  local out="${AGENTS_DIR}/${label}.plist"
  local env_xml=""
  if [[ -n "${ENV_XML:-}" ]]; then
    env_xml="${ENV_XML}"
  fi

  cat >"${out}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
$(printf '    <string>%s</string>\n' "${args[@]}")
  </array>
  <key>WorkingDirectory</key>
  <string>${workdir}</string>
${env_xml}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/${label}.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/${label}.err.log</string>
</dict>
</plist>
EOF
  echo "wrote ${out}"
}

load_agent() {
  local label="$1"
  local plist="${AGENTS_DIR}/${label}.plist"
  local domain="gui/$(id -u)"
  if launchctl print "${domain}/${label}" &>/dev/null; then
    launchctl bootout "${domain}/${label}" 2>/dev/null || true
    sleep 1
  fi
  if ! launchctl print "${domain}/${label}" &>/dev/null; then
    launchctl bootstrap "${domain}" "${plist}"
  fi
  launchctl enable "${domain}/${label}" 2>/dev/null || true
  launchctl kickstart -k "${domain}/${label}"
}

# --- pyserver (disable inherited HTTP proxies for AkShare/Eastmoney) ---
ENV_XML="  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "${UV_BIN}"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NO_PROXY</key>
    <string>localhost,127.0.0.1,::1,push2.eastmoney.com,.eastmoney.com</string>
    <key>HTTP_PROXY</key>
    <string></string>
    <key>HTTPS_PROXY</key>
    <string></string>
    <key>ALL_PROXY</key>
    <string></string>
    <key>http_proxy</key>
    <string></string>
    <key>https_proxy</key>
    <string></string>
    <key>all_proxy</key>
    <string></string>
  </dict>
"
write_plist "com.topkyo.ai-infra.pyserver" "${REPO_ROOT}/pyserver" \
  "${UV_BIN}" run python -m uvicorn main:app --host 127.0.0.1 --port 8001
unset ENV_XML

# --- web (production) ---
if [[ ! -f "${REPO_ROOT}/web/.next/BUILD_ID" ]]; then
  echo "building web production bundle..."
  (cd "${REPO_ROOT}/web" && "${NPM_BIN}" run build)
fi

echo "rebuilding native modules for ${NODE_BIN}..."
(
  export PATH="$(dirname "${NODE_BIN}"):/usr/bin:/bin"
  cd "${REPO_ROOT}/web/node_modules/better-sqlite3"
  rm -rf build
  npm run build-release
)

ENV_XML="  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "${NODE_BIN}"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>3000</string>
  </dict>
"
write_plist "com.topkyo.ai-infra.web" "${REPO_ROOT}/web" \
  "${NPM_BIN}" run start
unset ENV_XML

load_agent "com.topkyo.ai-infra.pyserver"
sleep 2
load_agent "com.topkyo.ai-infra.web"

echo ""
echo "Services installed. Logs: ${LOG_DIR}"
echo "  Web UI:    http://127.0.0.1:3000"
echo "  pyserver:  http://127.0.0.1:8001/health"
echo ""
sleep 3
curl -sf http://127.0.0.1:8001/health && echo "pyserver: ok" || echo "pyserver: not ready (see logs)"
curl -sf -o /dev/null http://127.0.0.1:3000 && echo "web: ok" || echo "web: not ready (see logs)"
