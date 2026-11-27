#!/usr/bin/env bash
# The simulation must be reproducible from its seed alone: one stray Math.random()
# makes every ecosystem-balance run non-repeatable and every bug report useless.
# Rendering and UI may use these freely; packages/sim may not.
set -uo pipefail
cd "$(dirname "$0")/.."

# Strip comments before matching, so the rule does not trip over its own docs.
hits=$(grep -rn --include='*.ts' -E 'Math\.random|Date\.now|performance\.now' packages/sim/src \
       | grep -vE ':[0-9]+: *(\*|//|/\*)' || true)

if [ -n "$hits" ]; then
  echo "FAIL: non-deterministic calls in packages/sim"
  echo "$hits"
  exit 1
fi
echo "OK: packages/sim is deterministic (no Math.random / Date.now / performance.now)"
