#!/usr/bin/env bash
# Public demo backend on NEAR testnet (keeps its state in .testnet-data/). Usage: bash scripts/testnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install --no-audit --no-fund
exec node --import tsx scripts/testnet-stack.ts "$@"
