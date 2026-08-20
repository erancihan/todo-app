#!/usr/bin/env bash
# Build daybook-core for wasm32 and generate the JS bindings the PWA imports.
#
# Output lands in app/src/core/wasm/ (git-ignored, regenerated). This is a build
# step for the browser target, not an optional extra: without it the PWA has no
# engine and `npm run dev` will fail to resolve the import.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="$HERE/src/core/wasm"
WASM_BINDGEN_VERSION="0.2.126"
PROFILE="${1:-release}"

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "error: wasm-bindgen not found." >&2
  echo "  cargo install wasm-bindgen-cli --version $WASM_BINDGEN_VERSION --locked" >&2
  exit 1
fi

# The CLI and the crate must be the exact same version. A mismatch produces glue
# that does not match the module's ABI, and it fails at runtime, not build time.
have="$(wasm-bindgen --version | awk '{print $2}')"
if [ "$have" != "$WASM_BINDGEN_VERSION" ]; then
  echo "error: wasm-bindgen $have found, but the crate pins $WASM_BINDGEN_VERSION." >&2
  exit 1
fi

echo "==> building daybook-core for wasm32 ($PROFILE)"
if [ "$PROFILE" = "debug" ]; then
  cargo build --manifest-path "$REPO_ROOT/Cargo.toml" \
    -p daybook-core --target wasm32-unknown-unknown
  WASM="$REPO_ROOT/target/wasm32-unknown-unknown/debug/daybook_core.wasm"
else
  cargo build --manifest-path "$REPO_ROOT/Cargo.toml" \
    -p daybook-core --target wasm32-unknown-unknown --release
  WASM="$REPO_ROOT/target/wasm32-unknown-unknown/release/daybook_core.wasm"
fi

echo "==> generating bindings into $OUT_DIR"
rm -rf "$OUT_DIR"
wasm-bindgen "$WASM" --out-dir "$OUT_DIR" --target web

echo "==> done ($(du -h "$OUT_DIR"/daybook_core_bg.wasm | cut -f1))"
