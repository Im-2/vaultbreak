#!/usr/bin/env bash
# Builds contract wasm files into contracts/*/out. Requires Rust + wasm32-unknown-unknown (Linux/WSL/macOS).
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTFLAGS='--cfg near -C link-arg=-s -C target-feature=-reference-types,-multivalue,-bulk-memory,-sign-ext,-nontrapping-fptoint'
cargo build --release --target wasm32-unknown-unknown -p vaultbreak-vault
mkdir -p contracts/vault/out
cp "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/vaultbreak_vault.wasm" contracts/vault/out/vault.wasm
echo "built contracts/vault/out/vault.wasm"
