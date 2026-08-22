# Daybook — development entry points.
#
#   make            list every target
#   make setup      one-time: install toolchain, deps, and the wasm-bindgen CLI
#   make dev        the usual loop — browser dev server on :1420
#   make dev-desktop  the Tauri shell (needs a display; see WSL notes below)
#   make check      everything CI runs, before you push
#
# WSL is a first-class case here: it is where Linux gets tested, and it has three
# sharp edges (file watching, WSLg, GPU) that this file handles rather than
# leaving you to hit them. `make doctor` reports what it found.

SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help setup dev dev-browser dev-desktop dev-relay wasm build build-web \
        build-desktop test test-rust test-web check fmt fmt-check lint smoke \
        spikes desktop-shot doctor clean clean-data

# --- environment detection -------------------------------------------------

# WSL reports a Microsoft kernel. Used to switch on the workarounds below.
IS_WSL := $(shell grep -qiE "microsoft|wsl" /proc/version 2>/dev/null && echo 1)

# Windows-mounted drives (/mnt/c/...) do not deliver inotify events and are slow
# over the 9p bridge. Vite's HMR is silently dead there, so we poll instead.
ON_WINDOWS_FS := $(if $(filter /mnt/%,$(CURDIR)),1,)

# WSLg provides the X/Wayland server that a desktop window needs.
HAS_DISPLAY := $(if $(or $(DISPLAY),$(WAYLAND_DISPLAY)),1,)

WASM_BINDGEN_VERSION := 0.2.126

# WebKitGTK under WSLg has no usable GPU path: without these the WebView process
# dies before it paints, which looks like the app silently failing to start.
WSL_WEBKIT_ENV := WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
DESKTOP_ENV := $(if $(IS_WSL),$(WSL_WEBKIT_ENV),)

# Polling costs CPU, so only turn it on where inotify genuinely does not work.
DEV_ENV := $(if $(ON_WINDOWS_FS),CHOKIDAR_USEPOLLING=1,)

# --- help ------------------------------------------------------------------

help:
	@echo "Daybook — make targets"
	@echo
	@echo "  setup           install the Rust target, npm deps, and wasm-bindgen CLI"
	@echo "  doctor          check this machine can build and run everything"
	@echo
	@echo "  dev             browser dev server on http://localhost:1420  (the usual loop)"
	@echo "  dev-desktop     the Tauri desktop shell"
	@echo "  dev-relay       the sync relay on http://localhost:8787"
	@echo
	@echo "  check           fmt + lint + all tests  (what CI runs)"
	@echo "  test            Rust and TypeScript unit tests"
	@echo "  smoke           drive the real app in headless Chromium"
	@echo "  spikes          the Phase 0 spike pages, headless"
	@echo "  desktop-shot    run the desktop app headless and screenshot it"
	@echo
	@echo "  wasm            rebuild the browser engine (crates/core -> wasm32)"
	@echo "  build           production build of everything"
	@echo "  clean           remove build artifacts"
	@echo "  clean-data      ALSO delete the local database (destructive)"
	@echo
ifdef IS_WSL
	@echo "  Detected: WSL."
ifdef ON_WINDOWS_FS
	@echo "  ! This repo lives on a Windows drive ($(CURDIR))."
	@echo "    File watching is unreliable there, so dev runs with polling enabled."
	@echo "    Builds are also several times slower. Cloning into the WSL home"
	@echo "    directory (~) instead is the single biggest speedup available."
endif
ifndef HAS_DISPLAY
	@echo "  ! No DISPLAY — 'make dev-desktop' needs WSLg. See 'make doctor'."
endif
endif

# --- setup -----------------------------------------------------------------

setup:
	@echo "==> Rust toolchain (pinned in rust-toolchain.toml)"
	rustup show active-toolchain || rustup toolchain install
	rustup target add wasm32-unknown-unknown
	@echo
	@echo "==> wasm-bindgen CLI"
	@# The CLI and the crate must match EXACTLY. A mismatch produces glue that
	@# does not match the module ABI, and it fails at runtime, not build time.
	@if command -v wasm-bindgen >/dev/null 2>&1 && \
	    [ "$$(wasm-bindgen --version | awk '{print $$2}')" = "$(WASM_BINDGEN_VERSION)" ]; then \
	  echo "    already at $(WASM_BINDGEN_VERSION)"; \
	else \
	  cargo install wasm-bindgen-cli --version $(WASM_BINDGEN_VERSION) --locked; \
	fi
	@echo
	@echo "==> npm dependencies"
	cd app && npm ci
	@echo
	@echo "Done. Run 'make doctor' to verify, then 'make dev'."

# --- development -----------------------------------------------------------

dev: dev-browser

dev-browser:
	@echo "==> Daybook — browser dev server"
	@echo "    http://localhost:1420"
ifdef IS_WSL
	@echo "    (WSL: open that in your Windows browser — localhost is forwarded)"
endif
ifdef ON_WINDOWS_FS
	@echo "    (polling file watcher enabled: repo is on a Windows drive)"
endif
	@echo
	cd app && $(DEV_ENV) npm run dev

dev-desktop:
ifdef IS_WSL
ifndef HAS_DISPLAY
	@echo "error: no DISPLAY set, so a desktop window cannot open." >&2
	@echo "  WSLg ships with WSL2 on Windows 11 and recent Windows 10." >&2
	@echo "  Check:  wsl --version   (from PowerShell, needs WSL 2)" >&2
	@echo "  Then:   wsl --update --shutdown" >&2
	@echo "  Headless alternative that always works:  make desktop-shot" >&2
	@exit 1
endif
	@echo "==> Daybook desktop (WSL: software rendering forced for WebKitGTK)"
else
	@echo "==> Daybook desktop"
endif
	cd app && $(DESKTOP_ENV) npm run tauri dev

dev-relay:
	@echo "==> daybook-relay on http://localhost:8787"
	cargo run -p daybook-relay -- --data-dir ./daybook-data

# --- build -----------------------------------------------------------------

wasm:
	cd app && npm run build:wasm

build: build-web build-desktop

build-web:
	cd app && npm run build

build-desktop: build-web
	cargo build -p daybook-app --release

# --- verification ----------------------------------------------------------

check: fmt-check lint test
	@echo
	@echo "All checks passed."

fmt:
	cargo fmt --all

fmt-check:
	@echo "==> rustfmt"
	cargo fmt --all -- --check

lint:
	@echo "==> clippy (native)"
	RUSTFLAGS="-D warnings" cargo clippy -p daybook-core -p daybook-relay \
	  --all-targets --all-features
	@echo "==> clippy (wasm32 — catches native-only deps leaking into shared code)"
	RUSTFLAGS="-D warnings" cargo clippy -p daybook-core \
	  --target wasm32-unknown-unknown --all-features

test: test-rust test-web

test-rust:
	@echo "==> Rust tests"
	cargo test -p daybook-core -p daybook-relay

test-web: wasm
	@echo "==> TypeScript tests"
	cd app && npm run typecheck && npm test

smoke: wasm
	@echo "==> browser smoke test (real wasm engine, real OPFS)"
	cd app && node scripts/smoke-browser.mjs

spikes:
	cd spikes && npm install --silent && npm run build:wasm && npm run test:headless

desktop-shot:
	bash scripts/run-linux-desktop.sh

# --- diagnostics -----------------------------------------------------------

doctor:
	@echo "Daybook — environment check"
	@echo
	@printf "  %-22s" "platform:"; \
	  if [ -n "$(IS_WSL)" ]; then echo "WSL ($$(uname -r))"; else uname -sr; fi
	@printf "  %-22s" "repo location:"; \
	  if [ -n "$(ON_WINDOWS_FS)" ]; then \
	    echo "$(CURDIR)  [Windows drive — slow, no inotify]"; \
	  else echo "$(CURDIR)  [ok]"; fi
	@printf "  %-22s" "rustc:"; rustc --version 2>/dev/null || echo "MISSING"
	@printf "  %-22s" "wasm32 target:"; \
	  rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown \
	    && echo "installed" || echo "MISSING — run 'make setup'"
	@printf "  %-22s" "wasm-bindgen:"; \
	  if command -v wasm-bindgen >/dev/null 2>&1; then \
	    v=$$(wasm-bindgen --version | awk '{print $$2}'); \
	    if [ "$$v" = "$(WASM_BINDGEN_VERSION)" ]; then echo "$$v [ok]"; \
	    else echo "$$v [MISMATCH — must be $(WASM_BINDGEN_VERSION)]"; fi; \
	  else echo "MISSING — run 'make setup'"; fi
	@printf "  %-22s" "node:"; node --version 2>/dev/null || echo "MISSING"
	@printf "  %-22s" "npm deps:"; \
	  [ -d app/node_modules ] && echo "installed" || echo "MISSING — run 'make setup'"
	@printf "  %-22s" "display:"; \
	  if [ -n "$(HAS_DISPLAY)" ]; then echo "$${DISPLAY:-$$WAYLAND_DISPLAY} [ok]"; \
	  else echo "none — 'make dev-desktop' will not work"; fi
	@printf "  %-22s" "webkit2gtk-4.1:"; \
	  pkg-config --exists webkit2gtk-4.1 2>/dev/null \
	    && echo "found" || echo "MISSING — needed for the desktop shell"
	@echo
ifdef IS_WSL
	@echo "  WSL notes"
	@echo "    - The desktop shell runs under WSLg with software rendering; this"
	@echo "      is WebKitGTK, NOT WKWebView, so it says nothing about macOS/iOS."
	@echo "    - If the desktop deps are missing:"
	@echo "        sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \\"
	@echo "          libayatana-appindicator3-dev librsvg2-dev patchelf"
ifdef ON_WINDOWS_FS
	@echo "    - Move this repo into the WSL filesystem (~) for a large speedup."
endif
endif

# --- cleaning --------------------------------------------------------------

clean:
	cargo clean
	rm -rf app/dist app/src/core/wasm spikes/wasm-opfs/pkg spikes/wasm-opfs/crate/target
	@echo "Build artifacts removed. Local databases were kept — 'make clean-data' drops those."

clean-data:
	@echo "This deletes the relay's data directory and any local projection."
	rm -rf daybook-data
	@echo "Removed ./daybook-data."
	@echo "The desktop app's database lives in the OS app-data directory:"
	@echo "  Linux/WSL:  ~/.local/share/app.daybook.desktop/"
	@echo "The browser's lives in OPFS — clear it from the app, or via site data."
