#!/usr/bin/env bash
# Downloads the near-sandbox binary into ~/.near-sandbox-bin (avoids cross-filesystem rename failures
# seen when /tmp and the install dir are different mounts). Prints the binary path.
set -euo pipefail
V="${NEAR_SANDBOX_VERSION:-2.14.0}"
D="$HOME/.near-sandbox-bin/near-sandbox-$V"
if [ ! -x "$D/near-sandbox" ]; then
  mkdir -p "$D"
  curl -sSfL "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/$V/near-sandbox.tar.gz" | tar xz --strip-components=1 -C "$D"
  chmod +x "$D/near-sandbox"
fi
echo "$D/near-sandbox"
