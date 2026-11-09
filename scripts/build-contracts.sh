#!/usr/bin/env bash
# Builds contract wasm files into contracts/*/out. Requires Rust + wasm32-unknown-unknown (Linux/WSL/macOS).
# Order matters: the registry embeds the vault wasm (include_bytes!), so the vault is built first.
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTFLAGS='--cfg near -C link-arg=-s -C target-feature=-reference-types,-multivalue,-bulk-memory,-sign-ext,-nontrapping-fptoint'
T="${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release"
cargo build --release --target wasm32-unknown-unknown -p vaultbreak-vault
mkdir -p contracts/vault/out && cp "$T/vaultbreak_vault.wasm" contracts/vault/out/vault.wasm
cargo build --release --target wasm32-unknown-unknown -p vaultbreak-registry
mkdir -p contracts/registry/out && cp "$T/vaultbreak_registry.wasm" contracts/registry/out/registry.wasm
ls -l contracts/vault/out/vault.wasm contracts/registry/out/registry.wasm | awk '{print "built", $9, $5, "bytes"}'
