# Phase 0 — iOS & Android spike: run book

**Status: BLOCKED ON HUMAN. Nothing in this file has been executed.**

The Phase 0 bootstrap ran in a headless Linux container: no macOS, no Xcode, no
Android SDK, no devices, no signing identities. Mobile is where the two most
expensive Phase 0 risks live (roadmap risks #1 and #3), so this is the exact work
that cannot be skipped — it just cannot be done here.

Everything below is written to be run top-to-bottom by a human on a Mac. Record
the result of each checkbox; the Phase 0 gate is not green until they are all
ticked or consciously waived.

> **Why a Mac specifically.** iOS builds require Xcode, which is macOS-only. A
> Linux or Windows machine can complete the **Android** half (§4) but not the iOS
> half (§3). macOS can do both.

---

## 0. What is already proven, and what these steps add

| Phase 0 exit criterion | Status after the bootstrap | What this run book adds |
| --- | --- | --- |
| yrs round-trips a concurrent `Y.Text` edit; snapshot + update encode/decode | ✅ **passing** — 7 unit tests in `crates/core` | nothing; already met |
| Core slice compiles to wasm32 and round-trips a write through sqlite-wasm + OPFS | ✅ **passing** — `spikes/wasm-opfs`, 8/8 headless | nothing; already met |
| `Ctrl/Cmd+Enter` submit vs `Enter`/`Shift+Enter` newline **on all four engines** | ⚠️ **partial** — 10/10 on Chromium | WKWebView (§3.6) + Android System WebView (§4.5) |
| App runs on macOS, Windows, iOS, Android, and a browser tab from one codebase | ⚠️ **partial** — browser ✅, Linux/WebKitGTK desktop ✅ | macOS (§2), Windows (§2), iOS (§3), Android (§4) |
| Image attach, soft `Return` = newline, on-screen Submit, on **both** iOS and Android | ❌ **not started** | §3.6, §4.5 |
| A signed iOS `.ipa` and an Android build, even if manual | ❌ **not started** | §3.7, §4.6 |

The **desktop** shell was launched here on Linux/WebKitGTK
(`spikes/tauri-desktop/run-linux.sh`), which proves the Tauri shell loads the Vite
bundle and that `invoke()` reaches `daybook-core`. That is real evidence for the
*shell wiring* and **not** evidence for WKWebView rendering or for any tier-1
desktop. Treat §2 as still required.

---

## 1. Prerequisites

```bash
# Toolchain — the repo pins it; this just makes sure it and the mobile targets exist.
rustup show                       # honors rust-toolchain.toml
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  i686-linux-android x86_64-linux-android

# Node 22+ and the JS deps
node --version
(cd app && npm ci)

# Tauri CLI — pinned in app/package.json, so use the local one, not a global install.
(cd app && npx tauri --version)   # expect 2.11.4
```

**iOS also needs:** Xcode 15+ (full install, not just Command Line Tools), an Apple
Developer account, and:

```bash
xcode-select --install
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -runFirstLaunch
brew install cocoapods
```

**Android also needs:** Android Studio, SDK Platform 34+, NDK, and:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 "$ANDROID_HOME/ndk" | tail -1)"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

Put those three exports in your shell profile — `tauri android` fails with unhelpful
errors when `NDK_HOME` is unset.

- [ ] Prerequisites installed; `npx tauri --version` prints `2.11.4`

---

## 2. Desktop first (do this before mobile)

Cheapest possible confirmation, and it isolates "is the app broken" from "is mobile
broken" before you spend time on signing.

```bash
cd app
npm run tauri dev
```

- [ ] **macOS:** window opens, dark Ink theme renders, both probe rows read `PASS`
- [ ] **macOS:** `Runtime:` reads `tauri/macos` — that is the IPC round-trip, live
- [ ] **Windows:** same, `Runtime:` reads `tauri/windows`

The two `PASS` rows are `yrs` merge and a `rusqlite` write/read executed **in Rust**
and returned over IPC. If they render, the engine port works on that platform.

> macOS is WKWebView and Windows is WebView2 — one platform from each engine family.
> Getting both green here is what makes the mobile results interpretable.

---

## 3. iOS

### 3.1 Initialize the Xcode project

```bash
cd app
npx tauri ios init
```

Generates `app/src-tauri/gen/apple/`. It is **git-ignored** — regenerate rather than
commit it.

- [ ] `tauri ios init` completed without errors

### 3.2 Set the bundle identifier and team

`identifier` in `app/src-tauri/tauri.conf.json` is `app.daybook.desktop`. Change it
to something you own **before** signing — an identifier that is not yours cannot be
provisioned.

```jsonc
{ "identifier": "com.yourdomain.daybook" }
```

Then in Xcode (`app/src-tauri/gen/apple/daybook.xcodeproj`) → target → Signing &
Capabilities → set your Team and let Xcode manage signing.

- [ ] Identifier changed to one you own
- [ ] Development team selected in Xcode

### 3.3 Run in the simulator

```bash
cd app
npx tauri ios dev
# pick a simulator when prompted, or:
npx tauri ios dev "iPhone 15 Pro"
```

- [ ] App launches in the simulator
- [ ] Dark theme renders; the Basecoat card and button look correct
- [ ] Both probe rows read `PASS`, `Runtime:` reads `tauri/ios`

> A blank white screen here almost always means the dev server is unreachable from
> the simulator. Confirm `npm run dev` is up on :1420 and that `devUrl` in
> `tauri.conf.json` is reachable from the simulator's network namespace.

### 3.4 Run on a real device

The simulator does not reproduce soft-keyboard behaviour faithfully. **The keyboard
criteria must be checked on hardware.**

```bash
cd app
npx tauri ios dev --host      # serves the dev server on the LAN for the device
```

- [ ] App launches on a physical iPhone
- [ ] Both probe rows read `PASS` on device

### 3.5 Serve the keymap harness to the device

The probe panel does not exercise the editor. Serve the spike page and open it in
Safari **on the phone**:

```bash
cd spikes
npm install
npm run build:wasm          # only needed for the wasm page
npx vite --host 0.0.0.0 --port 5174
# then browse to http://<your-mac-lan-ip>:5174/cm6-keymap/
```

- [ ] `/cm6-keymap/` reports all automated checks passing in **iOS Safari**
- [ ] `/wasm-opfs/` reports its checks in iOS Safari — **record the result**;
      OPFS support and the SAH-pool VFS are the likeliest divergence on WebKit

### 3.6 The three native-gap risks — check by hand on the device

This is the part that decides the gate. Automated checks cannot cover it.

**Soft keyboard (roadmap risk #3 — getting this wrong breaks capture on phones):**

- [ ] Tapping a row opens the editor and raises the soft keyboard
- [ ] **The soft `Return` key inserts a newline** and does *not* submit
- [ ] The accessory bar is visible above the keyboard, and its **✓ Submit** button
      submits and dismisses
- [ ] A hardware/Bluetooth keyboard's `Cmd+Enter` submits
- [ ] Touch targets are ≥44px (the harness switches to comfortable density under
      `@media (pointer: coarse)`)

**IME / composition:**

- [ ] Switch to a CJK or emoji keyboard; compose a multi-character sequence — the
      caret must not jump and characters must not duplicate
- [ ] Autocorrect accepting a suggestion does not reorder text

**Image attach:**

- [ ] Copy a photo in Photos, long-press → Paste in the editor: bytes reach the app
- [ ] Note whether a native gap needs filling here — Tauri v2's iOS plugin coverage
      is the known weak spot (roadmap risk #1). If paste does not deliver bytes,
      record exactly what is missing; that is a Phase 0 finding, not a bug to fix now.

**Background sync feasibility (record findings, do not build it):**

- [ ] Confirm whether a Tauri v2 iOS plugin can register a
      `BGAppRefreshTask`/`BGProcessingTask`, or whether it needs hand-written Swift
- [ ] Note what happens to an in-flight request when the app is backgrounded

### 3.7 Signed `.ipa`

```bash
cd app
npx tauri ios build                       # debug-signed
npx tauri ios build --export-method app-store-connect   # or: debugging, ad-hoc, enterprise
```

Output: `app/src-tauri/gen/apple/build/arm64/`.

If `tauri ios build` cannot resolve signing, fall back to Xcode: Product → Archive →
Distribute App. That is an acceptable Phase 0 outcome — the criterion is "even if
manually".

- [ ] A signed `.ipa` exists
- [ ] It installs on a real device and launches

> **Budget the pain.** `tauri-action` mobile CI was still in progress into 2026
> (roadmap risk #1), so expect to script release by hand. Record how long this took —
> that number is the input to the Phase 4 release-pipeline estimate.

---

## 4. Android

Android can be done from macOS, Linux, or Windows.

### 4.1 Initialize

```bash
cd app
npx tauri android init
```

- [ ] `tauri android init` completed without errors

### 4.2 Emulator

```bash
cd app
npx tauri android dev
```

- [ ] App launches in the emulator
- [ ] Both probe rows read `PASS`, `Runtime:` reads `tauri/android`

### 4.3 Real device

```bash
adb devices                  # confirm the device is authorized
cd app && npx tauri android dev --host
```

- [ ] App launches on a physical Android device

### 4.4 Serve the keymap harness to the device

- [ ] `/cm6-keymap/` reports all automated checks passing in **Android Chrome**
- [ ] `/cm6-keymap/` reports all automated checks passing in the **Android System
      WebView** (i.e. inside the Tauri app, not Chrome — these can differ, and the
      System WebView is the slowest renderer in the matrix)
- [ ] `/wasm-opfs/` result recorded

### 4.5 The same three native gaps, by hand

- [ ] Soft `Return` inserts a newline and does not submit
- [ ] Accessory-bar **✓ Submit** submits
- [ ] Gboard multi-character composition does not jump the caret
- [ ] Image paste/pick delivers bytes to Rust
- [ ] Touch targets ≥44px
- [ ] Note `WorkManager` feasibility for background sync

> Android's soft keyboard reports `Enter` differently across IMEs. If `Return`
> submits instead of inserting a newline on any IME, that is a **gate-blocking**
> finding — say so loudly.

### 4.6 Signed build

```bash
# One-time keystore
keytool -genkey -v -keystore ~/daybook-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias daybook

# app/src-tauri/gen/android/keystore.properties (DO NOT COMMIT)
#   storeFile=/Users/you/daybook-release.jks
#   storePassword=...
#   keyAlias=daybook
#   keyPassword=...

cd app
npx tauri android build --apk      # or --aab for Play
```

Output: `app/src-tauri/gen/android/app/build/outputs/`.

- [ ] A signed APK (or AAB) exists
- [ ] It installs on a real device and launches

`keystore.properties` and `*.jks` hold signing secrets — keep them out of the repo.

---

## 5. Report back

Phase 0 is a **go/no-go gate**, and a no-go found here is a success: it is the
cheapest possible place to learn it. Record, per platform:

| Platform | Launches | Probes PASS | `Return` = newline | Submit button | Image attach | Signed build |
| --- | --- | --- | --- | --- | --- | --- |
| macOS | | | n/a | n/a | | |
| Windows | | | n/a | n/a | | |
| iOS (sim) | | | | | | n/a |
| iOS (device) | | | | | | |
| Android (emu) | | | | | | n/a |
| Android (device) | | | | | | |

**Escalate immediately, before writing any Phase 1 code, if:**

- the soft `Return` cannot be kept as a newline on either platform — this breaks the
  core capture loop, and the fallback is a different editor or shell, not a patch;
- image bytes cannot reach Rust without writing substantial native code on both
  platforms;
- the WebView diverges badly enough on CSS or keyboard handling that the shared
  bundle stops being shared.

The no-go path is in `docs/05-roadmap.md`: stop and re-evaluate the UI shell
(egui fallback per ADR-001, or a webview alternative) **before** MVP code exists.
