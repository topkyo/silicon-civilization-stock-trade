#!/usr/bin/env bash
# Priority-1 connectivity checks for market data (run on the Mac host).
set -euo pipefail

echo "== proxy env =="
env | grep -i proxy || echo "(none)"

echo ""
echo "== local proxy port 7890 =="
nc -z 127.0.0.1 7890 2>/dev/null && echo "open (VPN likely on)" || echo "closed — start Clash/V2Ray or unset shell proxy"

echo ""
echo "== Eastmoney realtime (push2) =="
code=$(curl -sS -o /tmp/em.json -w "%{http_code}" --max-time 8 \
  'https://push2.eastmoney.com/api/qt/stock/get?fltt=2&invt=2&fields=f43,f58&secid=1.688256' 2>/dev/null || echo "000")
echo "HTTP $code $(head -c 120 /tmp/em.json 2>/dev/null)"

echo ""
echo "== pyserver health =="
curl -sf --max-time 5 http://127.0.0.1:8001/health | python3 -m json.tool 2>/dev/null || echo "pyserver down"

echo ""
echo "== AkShare hist (via uv) =="
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UV="${UV:-$(command -v uv 2>/dev/null || echo "${HOME}/.local/bin/uv")}"
cd "${REPO_ROOT}/pyserver"
"${UV}" run python -c "
from main import _ak_a_spot_from_hist, _ak_a_hist_df, _to_ts_code
for sym in ['688256', '600519']:
    ts, m = _to_ts_code(sym)
    df = _ak_a_hist_df(ts.split('.')[0], '20250501', '20250526', 'qfq')
    sp = _ak_a_spot_from_hist(ts, m, sym)
    print(sym, 'hist', len(df) if df is not None else None, 'spot', sp.get('price') if sp else None)
"

echo ""
echo "== spot API =="
for sym in 688256 600519; do
  echo -n "$sym: "
  curl -sf --max-time 20 "http://127.0.0.1:8001/spot?symbol=$sym" | head -c 100 || echo FAIL
  echo
done
