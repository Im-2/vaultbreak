#!/usr/bin/env bash
# Run a command inside WSL Ubuntu from the repo root (Windows host helper). Usage: scripts/wsl.sh "<cmd>"
WIN=$(pwd -W 2>/dev/null || pwd)
LIN=$(wsl -d Ubuntu -- wslpath -a "$WIN" | tr -d '\r')
wsl -d Ubuntu -- bash -lc ". ~/.cargo/env 2>/dev/null; export CARGO_TARGET_DIR=\$HOME/.vb-target; cd '$LIN' && $1"
