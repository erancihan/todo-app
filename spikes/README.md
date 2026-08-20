# Phase 0 spikes — throwaway

Proof-of-stack code for the go/no-go gate in [`docs/05-roadmap.md`](../docs/05-roadmap.md).
**This directory ships nothing.** It is deliberately outside the Cargo workspace
(`exclude = ["spikes"]`) and is not a dependency of `app/`, so it can be deleted
wholesale once Phase 1 starts.

Ugly is fine here. The assertions are not: every spike either passes a test or
renders a visible `PASS`/`FAIL`, and the headless runner exits non-zero on failure.

## What is here

| Spike | Proves | How it is verified |
| --- | --- | --- |
| **[`wasm-opfs/`](wasm-opfs/)** | `daybook-core` compiles to wasm32 and round-trips a write through sqlite-wasm + OPFS | 8 checks, headless |
| **[`cm6-keymap/`](cm6-keymap/)** | `Enter`/`Shift+Enter` newline vs `Ctrl/Cmd+Enter` submit; list ↔ editor focus handoff | 10 checks, headless |
| **[`mobile-README.md`](mobile-README.md)** | iOS / Android — **not run**, needs a Mac and devices | manual run book |

The `yrs` spike is **not** here: its exit criterion is "verified in a unit test", so
it lives with the code it tests, in [`crates/core/src/body.rs`](../crates/core/src/body.rs).

The Tauri desktop spike has **graduated** out of this directory. Now that the shell
runs the real Phase 1 app, launching it is a development task rather than a
proof — see [`scripts/run-linux-desktop.sh`](../scripts/run-linux-desktop.sh).

Two of these spikes are also now superseded by shipped code, and are kept only as
the Phase 0 evidence trail: the browser engine lives in `app/src/core/db-worker.ts`,
and the keymap is `app/src/core/keymap.ts` with its own unit tests. Delete this
directory when the Phase 0 gate is fully closed.

## Run them

```bash
# from spikes/
npm install
npm run build:wasm        # requires: cargo install wasm-bindgen-cli --version 0.2.126 --locked
npm run test:headless     # both browser pages in Chromium, exits non-zero on failure
npm run test:headless -- cm6     # just the keymap page
```

Interactively, which is how you drive them on a real phone or a WebView you cannot
automate:

```bash
npm run dev
#   http://localhost:5174/cm6-keymap/
#   http://localhost:5174/wasm-opfs/
# add --host 0.0.0.0 to reach it from a device on the LAN
```

The desktop run (now a dev script, not a spike):

```bash
# from the repo root — Linux/Xvfb only; on macOS or Windows just use `npm run tauri dev`
bash scripts/run-linux-desktop.sh
# writes target/desktop-run/tauri-window.png
```

## Coverage, honestly

`npm run test:headless` drives **Chromium only**. That covers one of the two engine
families — WebView2, Android System WebView, and evergreen Chrome/Edge. It is **no
evidence at all** for WebKit: WKWebView on iOS and macOS is unexercised, and so is
the Android System WebView specifically (Chromium-family, but a different and
usually older build than desktop Chrome).

Closing that gap is manual, and it is [`mobile-README.md`](mobile-README.md).

## Notes worth keeping when this directory is deleted

- **`wasm-bindgen` CLI and crate versions must match exactly** (both `0.2.126`).
  A mismatch produces glue that does not match the module ABI and fails at
  *runtime*, not build time. `wasm-opfs/build.sh` checks this and refuses to run.
- **The OPFS VFS choice matters.** The spike prefers `opfs-sahpool`, which works
  without COOP/COEP headers. The classic `opfs` VFS needs cross-origin isolation —
  requiring the shipped PWA to serve isolated pages just to have a local database.
  Prefer the SAH pool unless something forces otherwise.
- **Bind `Ctrl-Enter` and `Cmd-Enter` explicitly in CodeMirror, not just `Mod-Enter`.**
  `Mod` resolves via CodeMirror's own platform sniffing; binding the concrete forms
  means submit survives a misdetected platform. This was a real failure in the
  harness, not a hypothetical.
- **A live process is not a working app.** The Tauri script originally reported
  success while the WebView was showing "Connection refused" — a debug build loads
  `devUrl`, so the dev server must be up first. The script now checks screenshot
  luminance, because Daybook boots dark and an error page is white.
- **Only one tab can hold the OPFS database.** The SAH-pool VFS takes exclusive
  sync access handles, so a second tab on the same origin fails to open it. The
  app detects this and says so; a shared-worker or leader-election scheme is the
  real fix, and it is Phase 4 browser-hardening work.
- **`yrs` defaults to byte offsets, Yjs uses UTF-16.** `crates/core` sets
  `OffsetKind::Utf16` explicitly. Left at the default it works perfectly on ASCII
  and corrupts any body with an accent, CJK character, or emoji the moment a JS
  peer edits it.
