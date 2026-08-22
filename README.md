# Daybook

> An offline-first, keyboard-driven task app for iOS, macOS, Windows, and the browser (Android from the same codebase; Linux via the browser build) that captures as fast as a notepad and auto-generates a shareable markdown end-of-day report from what you actually did.

**Status: Phase 1 — MVP core (in progress).** The planning docs below lock the product, stack, data model, UX, and roadmap.

- **Phase 0 (proof-of-stack)** — partly green. The CRDT, browser/WASM, keymap, and desktop-shell criteria pass; the **iOS/Android criteria are outstanding** because they need a Mac and real devices. See [`spikes/README.md`](spikes/README.md) and the run book in [`spikes/mobile-README.md`](spikes/mobile-README.md).
- **Phase 1 (MVP core)** — the capture loop, single-table NODE model, event log, ordering, promotion, tags, and collections are implemented and run on **the browser and the Linux desktop**. Windows, macOS, iOS, and Android are untested here and are the owner's next targets.

---

## Repository layout

```
├── crates/
│   ├── core/          daybook-core — ONE crate, TWO builds
│   │   src/engine.rs    ← the Phase 1 engine: NODE CRUD, event log, ordering,
│   │                      promotion, tags, collections. Written ONCE; both
│   │                      hosts run this exact code.
│   │   src/store.rs     ← the only place the two builds differ (see below)
│   │   src/body.rs      ← BodyCrdt trait + yrs Y.Text
│   │   src/wasm.rs      ← wasm32-only bindgen surface for the PWA
│   └── relay/         daybook-relay — one self-contained Axum binary ($5-VPS sized)
│                        embedded SQLite op log + filesystem blobs + in-relay auth
│
├── app/               the web UI — ONE bundle serving both hosts
│   ├── src/core/      framework-agnostic plain TS. No Alpine in here.
│   │                    engine-port.ts    the seam (Tauri IPC | WASM worker)
│   │                    list-controller.ts mode, focus, what each key does
│   │                    keymap.ts          the authoritative bindings
│   │                    body-editor.ts     CodeMirror 6
│   │                    db-worker.ts       sqlite-wasm + OPFS driver
│   ├── src/main.ts    Alpine boot — the view layer, and only the view layer
│   └── src-tauri/     the Tauri v2 shell (desktop + mobile entry points)
│
├── scripts/           run-linux-desktop.sh — headless desktop run + screenshot
├── spikes/            Phase 0 throwaway — outside the workspace, ships nothing
├── docs/              the planning docs (source of truth; do not edit casually)
└── .github/workflows/ CI — fmt, clippy, tests, wasm32 build, browser smoke
```

### The one seam that matters

`crates/core/src/store.rs` defines a **deliberately tiny** `Store` trait: execute
SQL, return rows. It makes no decisions and knows nothing about nodes.

Everything that *thinks* lives above it in `engine.rs`, written once and shared
verbatim by both targets — `rusqlite` natively, `sqlite-wasm` + OPFS in the
browser, running the same `SCHEMA_SQL`. `app/src/core/engine-port.ts` mirrors that
seam in TypeScript: one interface, two pure-marshalling implementations.

The payoff: a WebView divergence can never become an *engine* divergence, because
there is only one engine. Widening `Store` is how that guarantee would be lost.

### Getting started

```bash
make setup     # Rust target, npm deps, and the pinned wasm-bindgen CLI
make doctor    # confirm this machine can build and run everything
make dev       # browser dev server on http://localhost:1420
```

Run `make` on its own for the full target list. The ones you'll use:

| | |
| --- | --- |
| `make dev` | Browser dev server — the usual loop |
| `make dev-desktop` | The Tauri desktop shell |
| `make check` | fmt + clippy + all tests (what CI runs) |
| `make smoke` | Drives the real app against real OPFS in headless Chromium |
| `make desktop-shot` | Runs the desktop app headless and screenshots it |
| `make clean-data` | Deletes the local database — destructive |

Building the browser engine needs the wasm-bindgen CLI at the **exact** pinned
version; a mismatch fails at runtime, not build time. `make setup` handles it, and
`make doctor` flags a drift.

Pinned versions live in [`Cargo.toml`](Cargo.toml) (`[workspace.dependencies]`, all
`=exact`), [`app/package.json`](app/package.json), and
[`rust-toolchain.toml`](rust-toolchain.toml).

### Running under WSL

WSL is where Linux gets tested. `make doctor` reports which of these apply:

- **Keep the repo in the WSL filesystem** (`~/…`), not on `/mnt/c`. Windows drives
  don't deliver inotify events, so Vite's hot reload silently stops working — edits
  just never appear. The Makefile switches to a polling watcher when it detects
  this, but builds are still several times slower over the 9p bridge.
- **`make dev-desktop` needs WSLg** for a window to open. If `DISPLAY` is unset,
  the target says so and points at `wsl --update`. `make desktop-shot` works
  headless either way.
- **The desktop shell is forced to software rendering** under WSL
  (`WEBKIT_DISABLE_COMPOSITING_MODE`, `WEBKIT_DISABLE_DMABUF_RENDERER`). Without
  those the WebKitGTK process dies before it paints, which looks like the app
  failing to start for no reason.
- Desktop system deps, if `make doctor` reports them missing:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf
  ```

A green run under WSL is WebKitGTK, **not** WKWebView — it says nothing about how
macOS or iOS will render.

### Known deviations from the docs

Both are flagged here rather than silently applied, and both are load-bearing:

| Doc | Deviation | Why |
| --- | --- | --- |
| [03 §5.3](docs/03-data-model.md) | `order_key` jitter separator is **`-`**, not `:` | `:` (ASCII 58) sorts *above* digits `0`-`9`, so `"V:dev" > "V7:dev"` and sibling order inverts under SQLite's `ORDER BY`. `-` (45) sorts below all 62 base62 digits. Base62 itself is unchanged. Locked by a test over the whole alphabet. |
| [02 §3](docs/02-architecture.md) | **Linux desktop** is a working develop-and-run target | The docs drop native Linux (the browser build covers it). It is not in the shipping matrix and is not packaged; it exists because it is what the current dev machine runs. WebKitGTK ≠ WKWebView, so a green Linux run says nothing about iOS/macOS. |

---

## Vision

Daybook is a **general-purpose task tracker for work and life** — a personal-first, multi-device app you live in all day. Fast, notepad-grade capture and rich organization are the core: dump tasks in with zero ceremony (markdown bodies, images, promotable sub-items) and organize them along two many-to-many axes — nestable **Collections** and free-form **Tags**. It's personal by default but **sharing-ready** and **server-agnostic** — a Collection can later be shared with other users, and the client can connect to multiple hosts. Because every change lands in an immutable event log, Daybook also writes your end-of-day report *for* you — a **standout feature derived from that log**, one feature of a general tracker, not the whole app.

The name says what it is: a daybook is a journal of the day's events — you jot tasks through the day and it becomes your end-of-day report.

## The Core Problem

The user writes end-of-day reports and drowns in tasks across both work and life. Existing apps fail at two things that matter most:

1. **Fast capture** — writing a todo should feel *as simple as writing to a notepad*: markdown body, images, sub-items, zero friction. `Enter`/`Shift+Enter` add newlines, `Ctrl+Enter` submits, arrows navigate, `e` edits.
2. **The EOD report** — the killer feature. Daybook derives a deterministic, shareable markdown report (created / updated / completed / carried-over) from an append-only event log, so the same day always reproduces the same report and unfinished items roll forward automatically.

Daybook is a full todo tracker first — collections, tags, promotable sub-items, sync; fast capture and the auto-EOD report are the two things it does markedly better than the alternatives.

## Decisions at a Glance

| Area | Decision | Why |
| --- | --- | --- |
| **UI framework** | **Tauri v2** — vanilla TypeScript + **Alpine.js** (v3, ~7KB) as a thin view layer + Tailwind v4 + Basecoat web UI over a Rust core. One codebase to tier 1 — **iOS, macOS, Windows (Tauri) + the browser (PWA, same core compiled to WASM)** — with **Android tier 2** and Linux served by the browser. | Only option that satisfies *both* hard constraints at once: every tier-1 target incl. iOS and the browser **and** Basecoat/Tailwind (DOM/CSS artifacts that need a browser engine). All hard state (local SQLite, CRDT/yrs via the engine port, sync client, virtualized node-tree, blob cache) lives in a framework-agnostic plain-TS **core/engine**; Alpine is only the reactive view, which neutralizes its weakness at large offline-first state. One Rust core crate compiles natively for Tauri and to wasm32 for the browser; egui rejected (it paints its own widgets, has no DOM, cannot render Basecoat). |
| **Backend & sync** | Self-hosted thin **Rust (Axum)** relay — **one self-contained binary** persisting the per-user **op log to embedded SQLite** (Postgres behind a storage trait for scale-up), sized for a **$5 VPS**; local **SQLite** on each device; offline-first. Email magic-link + JWT auth. | Single-user-multi-device, write-first, document-shaped. A thin relay fits offline-first better than turnkey engines (LWW-only ones clobber text; read-path-only ones can't write offline). Self-host-first: one binary + one data directory, no external DB or object store to stand up. |
| **Conflict model** | **Hybrid**: per-field last-writer-wins (HLC-stamped) for all scalars, enums, FKs, and the fractional `order_key`; a **Y.Text sequence CRDT** (yrs in the Rust core) only for the markdown body. Tombstone soft-deletes. | Concurrent character-level loss on a long body is the exact failure that feels broken — so the body earns a real CRDT while everything else stays simple, queryable LWW. CRDT sits behind a Rust trait so it can be swapped. |
| **Text editor** | **CodeMirror 6** with markdown language, Obsidian-style inline live preview, image paste, and the `y-codemirror.next` binding to each todo's Y.Text. Stores literal markdown. | Plaintext model = notepad feel, report-as-concatenation, cleanest CRDT merge, best mobile IME/keyboard story. |
| **Data model** | Single unified **NODE** table (todos + sub-items), self-referential via `parent_id` with a base62 **fractional `order_key`**. Promotion is an in-place upgrade (`promoted=true`), like GitHub sub-issues. Two many-to-many axes: nestable **Collections** via a **NODE_COLLECTION** join (replaces the old single Category FK) + free-form **Tags**. Append-only **EVENT** log. UUIDv7/ULID IDs. | One table makes promotion free; fractional indexing makes reorders conflict-free offline; the event log makes the EOD report deterministic; Collections being m2m + nestable makes them the shareable unit. |
| **Blob / image storage** | Content-addressed by **SHA-256** in the relay's blob store (**local filesystem by default**; S3-compatible — R2/Garage/MinIO — at scale) on a separate sync channel. Op log holds only hash + metadata + blurhash; on-device thumbnails via the Rust `image` crate, LRU-capped cache. | Keeps bytes out of the CRDT/op log; free dedup + integrity; list renders instantly from blurhash; the filesystem default keeps self-hosting to one binary. |
| **Keymap** | Vim-ish two-mode modality — **List mode** (single-key verbs, `j/k`/arrows, `e`/`Enter` to edit, `o`/`O` new, `Tab`/`Shift+Tab` indent, `p` promote, `x` done, `/` search, `Ctrl/Cmd+K` palette, `Ctrl/Cmd+Shift+E` EOD) and **Edit mode** (`Enter`/`Shift+Enter` newline, `Ctrl/Cmd+Enter` submit, `Esc` back). Touch maps every verb to a gesture + soft-keyboard accessory Submit. | The required keys are only unambiguous when navigation and composition are separated by mode. Mobile soft `Return` must stay a newline. |
| **Design system** | **Basecoat** ([basecoatui.com](https://basecoatui.com) — "shadcn/ui without React": plain-HTML components + tiny Alpine scripts) + Tailwind v4, low-chroma **"Ink"** neutral ladder + one restrained indigo accent (primary action + focus ring only). Basecoat is compatible with shadcn/ui OKLCH themes so the Ink token palette is **unchanged**; daisyUI is the documented styling fallback. Dark default, first-class light, OKLCH semantic tokens. 8px grid, dense desktop / comfortable-touch mobile density, Lucide icons. | The killer flows demand the UI disappear and the keyboard lead — the Linear/Raycast archetype. Collections carry the structural/accent role; tags get a muted 8-hue chip set so the two axes stay visually distinct. |
| **Sharing** | Personal-first but **sharing-ready**: a **Collection** is the unit of sharing and can later be shared with other users. Hooks designed in now; personal-only in MVP. | Designing the shareable boundary in from day one avoids a painful retrofit; keeping it dormant keeps the MVP simple. |
| **Hosting / accounts** | **Server-agnostic + multi-account**: an account = { host URL, credentials, identity on that host }; the client can connect to **multiple hosts**, each with its own accounts/collections, via a host/account switcher. The client shows **both an aggregate cross-host view** (all connected accounts combined) **and a per-host detail view**. Local store partitioned per account. Transport is **TLS only** — no client-side E2EE. | Multi-host keeps users un-locked-in; TLS-only (vs. E2EE) keeps the door open for server-side search. MVP may ship single-account, but the model + switcher UI are designed in. |

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/01-product-requirements.md](docs/01-product-requirements.md) | PRD — personas, the problem, functional + non-functional requirements, user stories, scope, MVP. |
| [docs/02-architecture.md](docs/02-architecture.md) | Stack decision + rationale (ADR-style), cross-platform strategy, sync/backend, storage, security, deployment. |
| [docs/03-data-model.md](docs/03-data-model.md) | Entities, ER description, CRDT/sync modeling, promotable sub-items, EOD report engine, example JSON. |
| [docs/04-ux-and-interaction.md](docs/04-ux-and-interaction.md) | Full keymap table, editor, capture flow, promotion flow, design system + tokens, key screens. |
| [docs/05-roadmap.md](docs/05-roadmap.md) | Phased milestones MVP → v1 → later, risks, open questions. |

## MVP in One Line

Tauri v2 on iOS, macOS, and Windows plus a browser PWA (same Rust core compiled to WASM; Android tier 2) with a vanilla-TS + Alpine.js view over a framework-agnostic plain-TS core, styled with Tailwind v4 + Basecoat; frictionless keyboard capture with the vim-ish List/Edit modality, CodeMirror 6 markdown editor with image paste, the single-table NODE model with promotable sub-items and the two many-to-many axes (Collections + Tags), offline-first SQLite with op-log sync over TLS to a single-binary Rust/Axum relay (embedded SQLite, $5-VPS-sized) with the multi-host account model designed in, content-addressed image attachments, and the deterministic EOD report engine with copy-as-markdown and carry-over.

## Open Questions

Most of the early unknowns are now **resolved**: the product is a general-purpose todo tracker that's **sharing-ready** with the **Collection** as the shareable unit (personal-only in MVP), with ACL roles **Owner / Collaborator / Viewer**; transport is **TLS-only** with no client-side E2EE; the EOD report is **deterministic and offline** — AI/MCP narrative is **out of scope, not planned**; hosting is **self-host-first** — one self-contained relay binary (embedded SQLite + filesystem blobs) sized for a $5 VPS, Postgres/S3 behind a storage trait for scale-up — and **multi-host** (server-agnostic, multi-account switcher) with **both an aggregate cross-host view and a per-host detail view**; and the codename is **Daybook**.

Genuinely residual: the finer sharing semantics on a shared Collection (e.g. a comment-only role, per-item permission overrides). See [docs/05-roadmap.md](docs/05-roadmap.md).
