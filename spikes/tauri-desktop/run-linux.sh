#!/usr/bin/env bash
# Spike 4 — launch the app/ UI inside the Tauri v2 shell and prove IPC into
# daybook-core works (throwaway).
#
# ## Why Linux, when Linux is not a target
#
# docs/02-architecture.md §3 deliberately drops native Linux — the browser build
# covers it. This script exists because Linux is the only desktop platform this
# environment has, and the thing under test is *the shell*: does the Vite bundle
# load inside a Tauri v2 WebView, and does `invoke()` reach the Rust core? That
# question is platform-independent. The WebView underneath is WebKitGTK, which is
# the WebKit family but NOT WKWebView — see the caveat at the end.
#
# For the tier-1 desktops, run `npm run tauri dev` on macOS or Windows; no script
# needed, and the same window should render the same probe rows.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/spikes/tauri-desktop/out}"
DISPLAY_NUM=":99"
SCREEN="1280x900x24"

mkdir -p "$OUT_DIR"

echo "==> building the UI bundle (app/dist)"
(cd "$REPO_ROOT/app" && npm run build >/dev/null)

echo "==> building the Tauri shell"
cargo build -p daybook-app --manifest-path "$REPO_ROOT/Cargo.toml"

BIN="$REPO_ROOT/target/debug/daybook-app"
[ -x "$BIN" ] || { echo "error: $BIN not built" >&2; exit 1; }

cleanup() {
  kill "${APP_PID:-}" 2>/dev/null || true
  kill "${VITE_PID:-}" 2>/dev/null || true
  kill "${XVFB_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

# `tauri::generate_context!()` resolves the frontend at COMPILE time: a debug
# build loads `build.devUrl` (the dev server), a release build loads the baked-in
# `build.frontendDist`. This is a debug build, so the dev server has to be up
# first — otherwise the WebView paints "Connection refused" and the app still
# looks alive to a naive process check.
echo "==> starting the Vite dev server on :1420 (devUrl)"
(cd "$REPO_ROOT/app" && npx vite --port 1420 --strictPort --host 127.0.0.1 \
  >"$OUT_DIR/vite.log" 2>&1) &
VITE_PID=$!

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null http://127.0.0.1:1420/; then break; fi
  sleep 0.5
done
if ! curl -sf -o /dev/null http://127.0.0.1:1420/; then
  echo "FAIL: the dev server never came up. Log:" >&2
  cat "$OUT_DIR/vite.log" >&2
  exit 1
fi

echo "==> starting Xvfb on $DISPLAY_NUM"
Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN" >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2

echo "==> launching Daybook"
# WebKitGTK needs both of these under Xvfb: there is no GPU and no DMA-BUF, and
# without them the WebView process dies before it paints.
DISPLAY="$DISPLAY_NUM" \
WEBKIT_DISABLE_COMPOSITING_MODE=1 \
WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  "$BIN" >"$OUT_DIR/app.log" 2>&1 &
APP_PID=$!

# Give the WebView time to boot, load the bundle, and complete the IPC round-trip.
sleep 12

if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo "FAIL: the app exited early. Log:" >&2
  cat "$OUT_DIR/app.log" >&2
  exit 1
fi

echo "==> capturing $OUT_DIR/tauri-window.png"
DISPLAY="$DISPLAY_NUM" import -window root "$OUT_DIR/tauri-window.png"

# "The process is still running" is NOT evidence the app works: a WebView that
# failed to reach devUrl paints a white "Connection refused" page and stays up
# happily. Daybook boots dark (Ink #0B0C0E), so a bright screenshot means the
# real UI never rendered. Crude, but it catches the exact failure seen in
# development.
MEAN=$(convert "$OUT_DIR/tauri-window.png" -colorspace Gray -format "%[fx:int(mean*255)]" info:)
echo "==> screenshot mean luminance: $MEAN/255 (Daybook boots dark)"
if [ "$MEAN" -gt 110 ]; then
  echo "FAIL: the window is too bright to be the Daybook UI — probably an error page." >&2
  echo "      Inspect $OUT_DIR/tauri-window.png" >&2
  exit 1
fi

echo
echo "PASS: the Tauri window launched, stayed up, and rendered the dark UI."
echo "  screenshot: $OUT_DIR/tauri-window.png"
echo "  log:        $OUT_DIR/app.log"
echo
echo "Check the screenshot for two PASS rows — those are IPC round-trips into"
echo "daybook-core (yrs merge + rusqlite write/read), not client-side stubs."
echo
echo "CAVEAT: this is WebKitGTK, not WKWebView. It shows the shell and IPC work;"
echo "it is NOT evidence for iOS/macOS rendering. See spikes/mobile-README.md."
