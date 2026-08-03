#!/usr/bin/env bash
# Builds the Phase 0 wasm slice of daybook-core and generates JS bindings into
# spikes/wasm-opfs/pkg/.
#
# Uses wasm-bindgen-cli directly rather than wasm-pack: one fewer tool to pin, and
# the version must match the `wasm-bindgen` crate pin exactly (0.2.126) or the
# generated glue will not match the module's ABI.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$HERE/crate"
OUT_DIR="$HERE/pkg"
WASM_BINDGEN_VERSION="0.2.126"

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "error: wasm-bindgen not found." >&2
  echo "  cargo install wasm-bindgen-cli --version $WASM_BINDGEN_VERSION --locked" >&2
  exit 1
fi

have="$(wasm-bindgen --version | awk '{print $2}')"
if [ "$have" != "$WASM_BINDGEN_VERSION" ]; then
  echo "error: wasm-bindgen $have found, but the crate pins $WASM_BINDGEN_VERSION." >&2
  echo "  Mismatched glue and module ABI fail at runtime, not build time." >&2
  exit 1
fi

echo "==> building daybook-wasm-spike for wasm32-unknown-unknown"
cargo build \
  --manifest-path "$CRATE_DIR/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release

echo "==> generating JS bindings into $OUT_DIR"
rm -rf "$OUT_DIR"
wasm-bindgen \
  "$CRATE_DIR/target/wasm32-unknown-unknown/release/daybook_wasm_spike.wasm" \
  --out-dir "$OUT_DIR" \
  --target web

echo "==> done"
ls -la "$OUT_DIR"
