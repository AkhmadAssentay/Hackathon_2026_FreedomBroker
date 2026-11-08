#!/usr/bin/env bash
# Control set in one command: fetch -> evaluate (router) -> results JSON 1.0 -> validate.
#   scripts/control_run.sh <group_id> [expected_count]
# Then: git add results/prod/results.json && git commit -m "Control results" && git push
set -euo pipefail
G="$1"; EXPECT="${2:-}"
OUT="${OUT:-results/prod/results.json}"
cd "$(dirname "$0")/.."
PY=.venv/bin/python
$PY -m scripts.run fetch --group "$G"
$PY -m scripts.run evaluate --group "$G" --provider "${PROVIDER:-router}" --workers 10
$PY -m scripts.export_results --group "$G" --out "$OUT"
RAW=$(ls -t data/raw/"$G"-*.json | head -1)
node alt/node-prototype/scripts/validate_results.js "$OUT" ${EXPECT:+--expect "$EXPECT"} --dataset "$RAW"
echo "spent so far: $($PY -m scripts.run budget | grep spent_usd)"
