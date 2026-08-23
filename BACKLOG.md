# Backlog

What is **not** built, why it is not built, and what the first step is.

This is the honest ledger against [`docs/05-roadmap.md`](docs/05-roadmap.md). Everything here is either blocked on hardware this repository has never had access to, or is a phase-sized piece of engineering rather than a loose end. Items are grouped by what is actually stopping them, because that is the only grouping that tells you what to do next.

Sibling docs: [README](README.md) · [01 — Product Requirements](docs/01-product-requirements.md) · [02 — Architecture](docs/02-architecture.md) · [03 — Data Model](docs/03-data-model.md) · [04 — UX](docs/04-ux-and-interaction.md) · [05 — Roadmap](docs/05-roadmap.md)

---

## Where the build actually is

| Phase | State |
| --- | --- |
| **Phase 0** — proof-of-stack | Green on CRDT, browser/WASM, keymap, desktop shell. **iOS/Android criteria outstanding** — they need a Mac and real devices. |
| **Phase 1** — MVP core | **Done** on browser + Linux desktop. Capture loop, single NODE table, event log, ordering, promotion, tags, collections, search, undo/redo, live preview. |
| **Phase 2** — sync + images | **Not started.** The relay crate exists as a skeleton and serves nothing. |
| **Phase 3** — EOD report + polish | **Mostly done.** Report engine, report view, detail view, sidebar, density/theme, reduced-motion, copy-as-markdown all ship. Inline thumbnails wait on Phase 2. |
| **Multi-tab browser** | **Done.** One tab holds the OPFS database and the others call it through a Web Lock + `BroadcastChannel`; the leader's tab closing promotes a waiter automatically. |
| **Phase 4** — mobile hardening + v1 | **Not started.** |

---

## Blocked on hardware this session never had

These are not hard. They are untestable from a Linux container, and shipping a build target verified only by "it compiled" is how the Phase 0 Tauri harness produced a false pass in the first place.

### iOS and Android
Needs a Mac, Xcode, an Apple Developer account, and real devices. The run book is already written: [`spikes/mobile-README.md`](spikes/mobile-README.md).

**First step:** `cargo tauri ios init` on the Mac, then work the exit criteria in the run book. The soft-keyboard behaviour is the part to check first — `Enter` must stay a newline and submit must live on an accessory button ([`docs/04` §4.2](docs/04-ux-and-interaction.md)). That is the binding most likely to be wrong on a real device, and it is invisible to any desktop test.

### Windows and macOS desktop packaging
The Tauri shell builds and runs on Linux. WebView2 and WKWebView are different engines with different quirks, and neither has been exercised.

**First step:** `make dev-desktop` on each machine, then `npm --prefix app run tauri build`. Watch for `Ctrl/Cmd+Enter` in particular — CodeMirror's `Mod-` binding resolves by platform sniffing, which is exactly why [`body-editor.ts`](app/src/core/body-editor.ts) binds all three forms explicitly.

---

## Phase-sized engineering, not loose ends

### Sync: the relay and the op-log channel
The largest remaining piece, and the second of the project's two big bets. Needs the Axum relay to persist a per-user op log, magic-link auth, per-device queues, and end-to-end verification of the hybrid conflict model.

The groundwork is deliberately in place: [`crates/core/src/op.rs`](crates/core/src/op.rs) and [`blob.rs`](crates/core/src/blob.rs) carry the types, every mutation already emits an HLC-stamped event, bodies are already `Y.Text` behind the `BodyCrdt` trait, and `order_key` already carries a per-device jitter suffix so concurrent inserts do not collide.

**First step:** the relay's storage trait and the op-log table, then a two-client convergence test — offline edits to the same body from two devices, converging with no lost characters. That test is the whole phase in miniature; write it before the transport.

### Image attachments
Content-addressed SHA-256 blobs on a separate sync channel, with blurhash degradation while bytes are in flight. Tied to Phase 2 by design — an attachment that cannot sync is a local file with extra steps.

**First step:** the local half. Paste-to-attach in CodeMirror, blob write, `![](attachment:<hash>)` in the body, and a decoration widget in [`live-preview.ts`](app/src/core/live-preview.ts). That is useful on its own and does not need the relay.

### Account and host switcher
[`docs/04` §8](docs/04-ux-and-interaction.md) puts a workspace-switcher above the collections sidebar, toggling an "All accounts" aggregate against a per-host view. It is deliberately absent: it is a surface for a feature that does not exist yet. There is exactly one local account until sync lands, and a switcher with one entry is chrome that teaches nothing.

**First step:** after Phase 2, when `{ host URL, credentials }` is a real thing to switch between.

---

## Deferred on judgement, not blocked

### List virtualization
[`docs/04` §7.7](docs/04-ux-and-interaction.md) lists virtualized rows. Not built, on purpose: virtualization fights `aria-activedescendant`, breaks `Ctrl+F`, and complicates focus management — real costs, paid now, against a benefit nobody has measured.

**First step:** measure. Generate a few thousand nodes and profile the list. If it is fine, delete this entry; if it is not, the row markup is already a flat `<li>` list with no per-row state, which is the easy case to virtualize.

### Drag-to-reorder
The keyboard path is complete (`Tab`/`Shift+Tab` to nest, `o`/`O`/`a` to place). Fractional indexing means a drop is a single `move_node` call, so the engine side is done — this is purely a pointer-interaction build, including a touch story and an accessible fallback.

**First step:** a drag handle on the row's hover affordances, `pointerdown`/`pointermove` with a drop indicator, resolving to `moveNode(id, newParent, after)`.

### Lucide icons
Icons are currently hand-inlined SVG. That is fine at this size and adds no dependency; a real icon set is worth it when the count grows past what one file should hold.

### EOD extras
Saved report templates, a standup format toggle (Yesterday / Today / Blockers), scheduled auto-generation, and HTML/JSON/PDF export. All named as later work in [`docs/03` §8.6](docs/03-data-model.md) and the roadmap's scoped backlog. The generator returns structured `sections` alongside the markdown precisely so these are presentation changes rather than a second engine.

### Board / kanban view
An alternate view over the same tree, listed as a later alternate in [`docs/04` §8](docs/04-ux-and-interaction.md).

---

## Known deviations from the docs

Recorded here so they are decisions rather than drift. Each is also commented where it lives.

| Deviation | Where | Why |
| --- | --- | --- |
| `order_key` jitter separator is `-`, not `:` | [`order_key.rs`](crates/core/src/order_key.rs) | ASCII `:` (58) sorts **above** the digits, so `"V:dev" > "V7:dev"` and the ordering breaks. `-` (45) sorts below the whole base62 alphabet. Covered by an exhaustive alphabet test. |
| `v` opens the detail view, not `Enter` | [`keymap.ts`](app/src/core/keymap.ts) | [`docs/04` §6](docs/04-ux-and-interaction.md) has `Enter` open the detail view for a *promoted* sub-item. That makes one key mean "edit here" on one row and "navigate away" on the next, decided by a flag the user cannot see. `v` works on any node; the promoted `↑` marker is the mouse affordance. |
| The detail body is a live editor, not a rendered preview | [`index.html`](app/index.html) | [`docs/04` §8](docs/04-ux-and-interaction.md) says "the rendered markdown body". Live preview already renders markdown inline, so a separate renderer would be a second markdown implementation to keep in agreement with the first — and it would put a mode switch between the reader and their own words. |
| Carry-over is bounded by a window | [`report.rs`](crates/core/src/report.rs) | [`docs/03` §8.2](docs/03-data-model.md)'s "touched earlier but unfinished", taken literally, carries every open todo ever created forever, and the report becomes an inventory instead of a diff. Bounded to a due date still in play, or last touched within `carryOverWindowDays` (7). |
| `slippedDays` counts reports, not calendar days | [`list-controller.ts`](app/src/core/list-controller.ts) | Only *today's* report writes `carried_over` events. Letting a history browse append would inflate every stale item a little more each time someone scrolled back through last week. A day you never opened Daybook does not count against you. |
| Accepting a `#tag` completion removes the token | [`token-complete.ts`](app/src/core/token-complete.ts) | Leaving `#urgent` in the prose *and* showing a chip says the same thing twice — once as content the report renders literally, once as the relation the data model holds. |

---

## Not planned

- **Client-side end-to-end encryption.** TLS plus at-rest encryption on a self-hostable backend is the shipped posture; self-hosting is the privacy lever. Stated as an explicit non-goal in the roadmap.
- **AI narrative prose in the report.** The generator is deterministic and offline, which is the point of it.
