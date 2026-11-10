#!/usr/bin/env bash
# One-command demo: sandbox + contracts + seeded Guardians + API + UI. Needs Linux/WSL/macOS, Node 22+, Rust (first run builds the contracts).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f web/public/assets/vault.jpg ] || npm -w web run assets
if [ ! -f contracts/registry/out/registry.wasm ] || [ ! -f contracts/pool/out/pool.wasm ]; then bash scripts/build-contracts.sh; fi
export NEAR_SANDBOX_BIN_PATH="$(bash scripts/fetch-sandbox.sh)"
exec node --import tsx scripts/dev-stack.ts "$@"
