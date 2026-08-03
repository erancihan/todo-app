# Daybook — Product Requirements Document

> Daybook is an offline-first, keyboard-driven task app for iOS, macOS, Windows, and the browser (Android from the same codebase; Linux via the browser build) that captures as fast as a notepad and auto-generates a shareable markdown end-of-day (EOD) report from what you actually did.

**Status:** Planning / design artifact (no application code yet).
**Related docs:** [Architecture](02-architecture.md) · [Data Model](03-data-model.md) · [UX & Interaction](04-ux-and-interaction.md) · [Roadmap](05-roadmap.md) · [Overview](../README.md)

---

## 1. Problem Statement

Knowledge workers who also run a busy personal life absorb tasks from everywhere — meetings, chat, email, their own head — across **both work and life**. Two things break down:

1. **Capture is too slow.** Every existing app adds ceremony at the moment of capture: pick a project, set a date, tag it, open a form. Friction at capture means tasks never get written down, and what isn't written down can't be reported.
2. **The end-of-day report is manual, lossy, and painful.** The user has to *write an EOD report* — for a manager, a standup, a client, or their own record. Reconstructing "what did I actually do today" from a scattered task list is guesswork. The tools that *can* produce a daily wrap (Sunsama, Akiflow) demand a 5–10 minute shutdown ritual; the tool that auto-generates one (TickTick) buries it in Notes and dumps a flat done/undone list with no narrative.

### The EOD-report motivation (the standout feature)

**Daybook is a general todo tracker first; the auto-report is what makes it worth switching.** A daybook is a journal of the day's events — and Daybook adds a twist to the usual model: you type todos at notepad speed all day for work and life, and Daybook *silently* records every meaningful state change in an append-only event log. At end of day — or any range you pick — it derives a clean, grouped, shareable **markdown** report of what was created, updated, completed, and carried over. No ritual. No manual "completed at" field. No DQL queries. You did the work; the report writes itself. The report is a *derived view* you pull when you need it — not a mode you must live in.

This auto-report is the single most differentiating feature layered on top of a fast, general-purpose task app.

---

## 2. Why Existing Tools Fall Short

No shipping app cleanly nails all three of: (1) frictionless keyboard-first capture, (2) automatic shareable EOD/standup reports from what you *did*, and (3) GitHub-issue-style promotable sub-items — across every platform you live on, offline-first.

| Tool | EOD/report story | Where it falls short for us |
| --- | --- | --- |
| **Sunsama** | Best-in-class "Daily Shutdown": AI highlights, task disposition, publishable markdown wrap to Slack/email | Shutdown is a **5–10 min ritual**, not silent; ~$20/mo; online-first; no promotable sub-items; not truly cross-platform |
| **Akiflow** | Daily Shutdown ritual reviews done work, replans undone | Emphasis is planning, not a shareable narrative; expensive; online-first; ceremony-heavy; no sub-issue model |
| **TickTick** | Hidden "Summary" auto-generates a filterable done+undone report, shareable/printable | Manual invocation, **buried in Notes**; a task-list dump, not a markdown narrative; weak markdown/images; no promotable sub-issues |
| **Linear** | True sub-issues + auto-standup digests (completed-in-24h → Yesterday/Today/Blockers) | Dev-team tool, not personal work+life; standup needs 3rd-party integrations; no life-tags axis, no image-attach focus |
| **Todoist** | Productivity view + Activity log (dated event feed) | Event feed, **not a narrative report**; no markdown digest/export; shallow subtasks; report history gated by plan |
| **Obsidian / Logseq** | DIY "done today" via Dataview/Tasks/LOGBOOK queries in daily notes | Requires plugins + query knowledge — the **opposite of notepad-simple**; sync is paid/self-managed; no native promotable sub-issue |
| **Tana / Notion** | AI command nodes / linked "Completed This Week" views can build a report | Supertag/DB ceremony at capture; manual "Completed At"; not robustly offline-first; reports are build-it-yourself |
| **Superlist** | Sleek modern UI, markdown, keyboard, AI meeting→task | **No EOD/standup report at all**; no promotable sub-issue model |
| **Things 3** | Logbook archives completed items | **Apple-only** (disqualified by the cross-platform requirement); no native report/export |

**The unoccupied position:** notepad-speed capture that silently produces a first-class, auto-generated, markdown EOD report — **personal-first but sharing-ready** (Collections as the future shareable unit) and **server-agnostic** (bring your own host). Differentiation must be that Daybook's report is **automatic and capture is visibly faster** — otherwise it reads as a Sunsama/TickTick clone.

---

## 3. Target Users & Personas

Primary user: someone drowning in **work-and-life** tasks who is **on the hook to report** what they did.

| Persona | Context | Core need | EOD trigger |
| --- | --- | --- | --- |
| **The Reporting IC** (primary) | Engineer / PM / analyst who writes a daily EOD or attends standup | Capture at meeting speed; auto-produce "what I did today" in markdown to paste into Slack/Jira/email | Daily standup + manager EOD |
| **The Dual-Life Juggler** | Blends a demanding job with a full personal life (family, side projects, errands) | One app for both axes without them bleeding together; report *just* the work slice when needed | Work EOD, personal weekly review |
| **The Keyboard Power User** | Lives in Linear/Vim/Raycast; hands never leave home row | Zero-mouse operation, single-key list verbs, command palette | Any-time custom-range report |
| **The Cross-Platform Nomad** | Types on a Windows or macOS desktop (or Daybook in a browser tab on Linux), captures on an iPhone or Android on the go | Reliable offline capture on the phone, full editing on desktop, seamless sync incl. images | Reviews/generates report on whichever device is closest |

**Not** our target: dev teams needing collaborative project management (Linear/Jira), pure note-takers (Reflect/Obsidian-as-notes), or single-platform Apple loyalists (Things).

---

## 4. Goals & Non-Goals

### Goals
1. **Capture as fast as a notepad** — zero-ceremony, insert-by-default, `Ctrl/Cmd+Enter` to submit.
2. **Make the EOD report automatic** — derived from an immutable event log, deterministic, offline, copy-as-markdown.
3. **Keyboard-first control** — a coherent vim-ish List/Edit modality honoring the exact required keymap.
4. **Genuine cross-platform reach** — tier 1: **iOS, macOS, Windows, and the browser (installable PWA)** from one codebase (non-negotiable); tier 2: **Android** from the same codebase; **Linux is served by the browser build** (no native Linux target).
5. **Offline-first with sync** — local SQLite is the source of truth on-device; sync when online, never block on the network.
6. **Two distinct organizing axes** — many-to-many Collections (structural, shareable) + many-to-many Tags (lightweight, personal), both powering report grouping.
7. **GitHub-issue-style structure** — sub-items that can be promoted in place into full todos.
8. **Sleek, modern design** — Tailwind v4 + Basecoat (shadcn-theme-compatible, no React), dark-default, dense desktop / comfortable mobile.
9. **Rich bodies** — markdown editing with inline live preview and **attached, synced images**.

### Non-Goals (MVP)
- **Real-time collaboration / multi-user editing.** Daybook is personal-first; a **Collection** is the designed-in unit of future sharing, but MVP ships **personal-only** (hooks now — see 5.10 Sharing).
- **AI-generated narrative prose / LLM integration.** The report engine is **deterministic/offline**; **AI narrative and any MCP integration are OUT OF SCOPE (not planned)** — not a phase, not a "Later." The template generator is the whole story.
- **End-to-end encryption.** MVP uses **transport (TLS) encryption only**; at-rest is the self-hosted server's responsibility. E2EE is an **explicitly-deferred non-goal** (keeping the door open for server-side search).
- **Board/kanban, calendar time-blocking, Pomodoro/time-tracking.** Not the core loop.
- **Full mobile feature parity with desktop.** Mobile MVP = fast capture + read/browse + report view; heavy editing is desktop-first.
- **Non-markdown export formats** (HTML/JSON/PDF) — markdown is the universal paste target for MVP.

---

## 5. Functional Requirements (MoSCoW)

Priorities: **Must** (MVP-blocking) · **Should** (MVP if time allows) · **Could** (nice-to-have) · **Won't** (explicitly out for now).

### 5.1 Capture (notepad-simple)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-CAP-1 | A quick-capture bar / new-row action creates a todo with **zero required fields** (just a body). | Must |
| FR-CAP-2 | Capture is **insert-by-default**: a new user can just type without learning modes. | Must |
| FR-CAP-3 | `Ctrl/Cmd+Enter` submits the current todo; `Enter` and `Shift+Enter` both insert a newline while composing. | Must |
| FR-CAP-4 | IDs are client-generated (UUIDv7/ULID) so todos can be created fully offline. | Must |
| FR-CAP-5 | Command palette (`Ctrl/Cmd+K`) for capture and every action, so non-power-users can type their way to anything. | Must |

### 5.2 Markdown bodies
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-MD-1 | Todo bodies support GitHub-flavored markdown, stored as the **literal markdown string** (report = concatenation of bodies). | Must |
| FR-MD-2 | Obsidian-style **inline live preview** (hide syntax tokens when the caret leaves them; render inline image widgets). | Must |
| FR-MD-3 | Paste an image directly into the body to attach it. | Must |
| FR-MD-4 | Editor manages its own input layer for reliable mobile soft-keyboard / IME behavior (CodeMirror 6). | Must |

### 5.3 Collections (axis 1 — structural, shareable)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-COL-1 | A node can belong to **multiple Collections** (many-to-many) — no single-select bucket. | Must |
| FR-COL-2 | Collections are user-defined, **optionally nestable** named containers that carry the accent/structural color role; they are the **shareable unit** (see 5.10). | Must |
| FR-COL-3 | Collection membership is mergeable across devices via a tombstoned join (no lost/duplicated membership on concurrent edits). | Must |
| FR-COL-4 | Assign/remove Collections from List mode (`c`) and the command palette. | Must |

### 5.4 Tags (axis 2 — lightweight, personal)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-TAG-1 | **Many-to-many** tags per node — lightweight, flat personal labels distinct from Collections (a controlled muted chip set). | Must |
| FR-TAG-2 | Tags mergeable across devices via a tombstoned join (no lost/duplicated tags on concurrent edits). | Must |
| FR-TAG-3 | Assign/remove tags from List mode (`t`) and the command palette. | Must |

### 5.5 Sub-items & promotion
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-SUB-1 | A todo can have **multiple sub-items** (nested checklist children). | Must |
| FR-SUB-2 | A sub-item can be **promoted in place** into a full todo with its own body, tags, Collections, sub-items, and attachments — GitHub's sub-issue model (no row copy; `promoted=true` + event). | Must |
| FR-SUB-3 | Indent/outdent (`Tab`/`Shift+Tab`) and reorder without server round-trips (fractional indexing). | Must |
| FR-SUB-4 | `x` toggles done on the focused node; sub-item completion contributes to the report. | Must |

### 5.6 Images / attachments
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-IMG-1 | Attach images to todos, **stored in the app** and synced across devices. | Must |
| FR-IMG-2 | Blobs are **content-addressed by SHA-256** (free dedup + integrity), synced on a **separate channel** from the op log. | Must |
| FR-IMG-3 | On-device thumbnail + blurhash so a todo renders immediately while the full image lazy-loads. | Must |
| FR-IMG-4 | Offline upload/download queue + LRU size-capped local blob cache. | Must |
| FR-IMG-5 | UI degrades gracefully to blurhash/thumbnail when full bytes haven't downloaded yet. | Should |

### 5.7 Cross-platform
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-XP-1 | Ship tier 1 — **iOS, macOS, Windows (Tauri v2) + the browser (installable PWA)** — from one codebase: vanilla TypeScript + Alpine.js + Tailwind v4 + Basecoat over **one Rust core crate**, compiled natively for Tauri and to **WASM** for the browser. | Must |
| FR-XP-2 | Desktop is first-class; mobile MVP is scoped to **fast capture + read/browse + report view**. | Must |
| FR-XP-3 | The browser build is a **full offline replica**: sqlite-wasm + **OPFS** local store, service-worker offline, installable PWA, persistent-storage permission requested. It **covers Linux** (no native Linux target). | Must |
| FR-XP-4 | **Android** ships tier 2 from the same Tauri codebase (capture-focused, same scope as iOS). | Should |
| FR-XP-5 | Per-platform keyboard/IME QA across the **two engine families** — WebKit (WKWebView) + Chromium (WebView2, Android WebView, evergreen browsers); keep heavy blur/filters a progressive enhancement. | Should |

### 5.8 Offline-first sync
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-SYNC-1 | Local SQLite store; app is **fully usable offline**, sync when online, never block on network. | Must |
| FR-SYNC-2 | Client op-log sync to a thin Rust (Axum) relay persisting a per-user op log in its **embedded store** (SQLite by default; Postgres behind the same storage trait at scale). | Must |
| FR-SYNC-3 | **Hybrid conflict model**: per-field LWW (HLC/Lamport) for scalars/enums/FKs/order_key; a **Y.Text sequence CRDT** (via `yrs`) only for the markdown body. | Must |
| FR-SYNC-4 | Tombstone soft-deletes with causal-watermark GC (never resurrect deleted todos). | Must |
| FR-SYNC-5 | Email **magic-link + JWT** auth. | Must |
| FR-SYNC-6 | Body CRDT sits behind a Rust trait so the engine can be swapped later. | Should |

### 5.9 Multi-host / bring-your-own-server
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-HOST-1 | An **Account** = `{ host URL, credentials, identity }`; the local store is **partitioned per account** (no data bleed between hosts). | Must |
| FR-HOST-2 | Daybook is **server-agnostic**: connect to any self-hosted (or other) Daybook server via an **add/select-server** flow. | Must |
| FR-HOST-3 | The client can hold **multiple accounts/hosts** with a host/account **switcher** in the UI. | Should |
| FR-HOST-4 | MVP **may ship single-account**, but the multi-account model + switcher are **designed in** from day one. | Should |
| FR-HOST-5 | With multiple hosts connected, the UI offers **both an aggregate cross-host view** (all accounts merged) **and a per-host detail view** (one account in isolation). | Should |
| FR-HOST-6 | The server ships as a **single self-contained binary** (embedded SQLite + filesystem blob store + in-relay auth) with minimum requirements that fit a **$5-class VPS** (1 shared vCPU, 512 MB RAM, a few GB disk) — **no external database or object store required** to self-host. | Must |

### 5.10 Sharing (Later)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-SHARE-1 | A **Collection** is the **unit of sharing** and can **later** be shared with other users. | Could (designed-for) |
| FR-SHARE-2 | Share roles: **Owner / Collaborator / Viewer**. | Could (designed-for) |
| FR-SHARE-3 | MVP builds the **hooks** (data model + sync leave room) but ships **personal-only**. | Won't (MVP) / designed-in |

### 5.11 EOD report engine (killer feature)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-EOD-1 | Derive reports from the **immutable event log** over a timezone-aware local-day range (default: today). | Must |
| FR-EOD-2 | Bucket events into **CREATED / UPDATED / COMPLETED / CARRIED_OVER**; resolve to current node snapshots. | Must |
| FR-EOD-3 | **Deterministic markdown template** (fully offline): checkbox bullets, nested sub-item rollups, tag chips, timestamps. | Must |
| FR-EOD-4 | **Group-by Collection** (MVP); group-by Tag / project-root as pivots. | Must (collection) / Should (others) |
| FR-EOD-5 | **Copy-as-markdown** as the primary export. | Must |
| FR-EOD-6 | **Carry-over**: roll unfinished in-scope items forward, track a slipped-days count. | Must |
| FR-EOD-7 | Custom date range (yesterday / this week / arbitrary). | Should |
| FR-EOD-8 | "**What changed**" diff — sub-items checked, promotions, status flips — not just completions. | Should |
| FR-EOD-9 | Optional inline thumbnails embedded in the export. | Could |
| FR-EOD-10 | Standup format toggle (Yesterday / Today / Blockers); scheduled auto-generation — MVP report engine stays deterministic/offline. *(AI narrative / MCP are out of scope — not planned.)* | Won't (MVP) |

### 5.12 Keyboard control
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-KEY-1 | **Vim-ish two-mode** modality: LIST (navigation) and EDIT (CodeMirror active). Full keymap in [UX & Interaction](04-ux-and-interaction.md). | Must |
| FR-KEY-2 | Exact keys honored: `Enter`/`Shift+Enter` = newline (Edit); `Ctrl/Cmd+Enter` = submit; **arrow keys** navigate between todos; **`e`** edits the focused todo. | Must |
| FR-KEY-3 | List-mode verbs: `j/k` + arrows nav, `Enter`/`e` edit, `o/O` new sibling, `Tab/Shift+Tab` indent/outdent, `p` promote, `x` toggle done, `t` tag, `c` collection, `/` search, `Ctrl/Cmd+K` palette, `Ctrl/Cmd+Shift+E` generate EOD. | Must |
| FR-KEY-4 | Persistent **mode pill + caret-color** change makes modality legible; `Esc` returns to List. | Must |
| FR-KEY-5 | `?` **cheat-sheet overlay** for discoverability. | Must |
| FR-KEY-6 | **Touch has no single-key layer**: every List verb maps to a gesture (tap=edit, swipe-right=done, swipe-left=actions, long-press-drag=reorder/indent, FAB=quick-add), plus an **accessory toolbar** above the soft keyboard with a dedicated **Submit** button (soft Return stays a newline). | Must |

---

## 6. Non-Functional Requirements

| Category | Requirement |
| --- | --- |
| **Performance** | Capture-to-persist feels instant (local write, no network in the hot path). List renders large trees smoothly; images render from blurhash first. Keep heavy blur/filter elevation a progressive enhancement across the webview + browser matrix. |
| **Offline** | Full create/edit/complete/promote/tag/assign-to-Collection while offline; changes queue and sync on reconnect. SQLite is a deterministic projection of the CRDT/op-log source of truth. |
| **Sync correctness** | No lost concurrent body edits (Y.Text CRDT). No lost/duplicated tags or Collection membership (m2m tombstoned joins). No resurrected deletes (causal-watermark GC only). Two channels (op log + blobs) may lag; UI degrades gracefully, never errors. |
| **Security / Privacy** | **Transport (TLS) encryption only**; encryption at rest is the self-hosted server's responsibility. Email magic-link + JWT auth. Deterministic report generation keeps report data **offline and private by default** — no data leaves the device unless the user syncs/exports. **E2EE is a deferred non-goal** (keeps server-side search open). AI narrative / MCP integration are **out of scope (not planned)**. |
| **Accessibility** | Honor `prefers-reduced-motion`; first-class light theme alongside dark default; keyboard-operable everywhere (a keyboard-first app must also be screen-reader and focus-visible correct); mobile touch targets ≥ 40–44px via auto comfortable density. |
| **Platform coverage** | Tier 1 (iOS, macOS, Windows via Tauri v2 + the browser via the WASM core) and tier 2 (Android) from one codebase; Linux served by the browser build. Validate an iOS/Android build spike (image attach, background sync, capture) and a core-to-WASM spike before committing; budget hand-rolled mobile signing/release pipelines. |
| **Self-host footprint** | The sync server runs as **one self-contained binary** on a $5-class VPS: 1 shared vCPU, 512 MB RAM, a few GB disk; embedded SQLite + filesystem blob store; backup = snapshot one data directory. Postgres/S3 are scale-up options, never self-host prerequisites. |
| **Design quality** | Daybook design system: Tailwind v4 + Basecoat (shadcn-theme-compatible, no React; daisyUI as styling fallback), **unchanged** OKLCH semantic tokens — low-chroma "Ink" ladder + single restrained indigo accent, 8px grid, dense 28–32px desktop rows / 40–44px mobile, hairline borders, Lucide icons, fast subtle motion. Details in [UX & Interaction](04-ux-and-interaction.md). |
| **Reliability / data durability** | Client-generated IDs; append-only immutable event log makes the same range always reproduce the same report (auditable). Schedule op-log/CRDT compaction + tombstone GC behind a causal watermark. |

---

## 7. User Stories (key flows)

### Capture
- *As a reporting IC*, I press one key, type a task in a meeting, and hit `Ctrl+Enter` — no fields, no mouse — so the thought is captured before the meeting moves on.
- *As a mobile nomad*, I tap the FAB, type on my phone offline on the train, and the soft Return still makes newlines while a Submit button on the keyboard accessory bar commits — so the capture loop works on a phone.

### Markdown & images
- *As a dual-life juggler*, I paste a screenshot of an error into a work todo's body and see it inline; it syncs to my desktop where I finish the task.
- *As a power user*, I write a todo body in markdown with a checklist and a link, and it renders live-preview without me leaving the keyboard.

### Organize (two axes)
- *As a dual-life juggler*, I add a todo to my `Home > Renovation` **Collection** — and, because Collections are many-to-many, also to `Q3 Budget` — and tag it `#urgent` and `#call`, so I can later report only work items or slice by tag.

### Sub-items & promotion
- *As a reporting IC*, I add three sub-items under a todo; one grows in scope, so I press `p` to **promote** it into its own full todo with its own body and tags — without losing its place or history.

### Sync & offline
- *As a nomad*, I complete tasks offline on my laptop and my phone independently; when both reconnect, nothing is lost and my markdown bodies merge cleanly.

### The EOD report (killer flow)
- *As a reporting IC at 5pm*, I press `Ctrl/Cmd+Shift+E`, Daybook generates a markdown report of everything I **created, updated, completed, and carried over** today, grouped by Collection, and I **copy-as-markdown** straight into Slack — no ritual, no manual "completed at."
- *As a manager-facing IC*, unfinished items **carry over** to tomorrow with a slipped-days count, and the report surfaces the "what changed" diff (sub-items checked, promotions), so my EOD reflects real progress, not just checkboxes.
- *As a nomad*, I generate the same report from any device for any custom range, and it reproduces identically because it's derived from the immutable event log.

---

## 8. Scope

### In scope (product)
Personal multi-device task capture, markdown bodies with images, many-to-many Collections (structural, shareable) + many-to-many Tags (lightweight, personal), promotable sub-items, offline-first sync, a **server-agnostic multi-account model** (single-account in MVP, switcher designed in), and the automatic EOD report — on iOS, macOS, Windows, and the browser (Android tier 2) with a keyboard-first, Basecoat-styled UI. Collection sharing hooks are designed in but ship personal-only.

### Out of scope (now)
Real-time collaboration / multi-user editing (Collection sharing is designed-in but Later); E2EE (deferred non-goal); AI narrative / MCP integration (out of scope — not planned); board/kanban; calendar/time-blocking; time tracking; non-markdown export; native mobile integrations (share-sheet, widgets, App Intents); productivity analytics dashboards.

---

## 9. MVP Cut

The MVP delivers the full killer loop — notepad-fast capture → structured todos → automatic markdown EOD report — on every tier-1 platform, offline-first.

**In MVP**
- Tauri v2 shell on iOS, macOS, and Windows + a browser PWA running the same Rust core compiled to WASM; Android tier 2 from the same codebase (desktop first-class; mobile = fast capture + read/browse + report view).
- Frictionless keyboard capture with the vim-ish List/Edit modality and the exact keymap (`Enter`/`Shift+Enter` = newline, `Ctrl/Cmd+Enter` = submit, arrows navigate, `e` = edit).
- CodeMirror 6 markdown editor with inline live preview and image paste.
- Single-table NODE model: todos, nested sub-items, in-place promotion of a sub-item to a full todo.
- Two axes: many-to-many Collections (structural, shareable) + many-to-many Tags (lightweight, personal).
- Server-agnostic **account model** ({ host URL, credentials, identity }, per-account store) — single-account in MVP, but the add/select-server flow + host/account switcher are designed in.
- Local SQLite (rusqlite native / sqlite-wasm + OPFS in the browser), fully offline-first; client op-log sync to a thin Rust (Axum) relay shipped as one self-contained binary with embedded SQLite persistence, sized for a $5 VPS.
- Hybrid conflict model: per-field LWW (HLC) for scalars/structure + Y.Text CRDT for the markdown body; tombstone soft-deletes.
- Email magic-link + JWT auth.
- Image attachments: paste/attach, content-addressed (SHA-256) blobs synced on a separate channel to the relay's blob store (local filesystem by default; S3-compatible at scale), on-device thumbnails/blurhash, offline upload/download queue.
- EOD report engine from the append-only event log: today + custom range, group-by-collection, deterministic markdown template, copy-as-markdown + carry-over of unfinished items.
- Daybook design system: Tailwind v4 + Basecoat over vanilla TypeScript + Alpine.js (v3), CodeMirror 6 + y-codemirror.next editor, dark default + light theme, dense desktop / comfortable mobile density, command palette, quick-capture bar, detailed GitHub-issue todo view.
- `?` cheat-sheet overlay and command palette for keymap discoverability; mobile gesture equivalents + soft-keyboard accessory Submit button.

**Explicitly later** (see [Roadmap](05-roadmap.md)): scheduled auto-generation, standup format toggle + extra group-by pivots, board/kanban view, E2EE, Collection sharing/collaboration (Owner/Collaborator/Viewer), multi-account/multi-host switcher (beyond MVP single-account), extra export formats (HTML/JSON/PDF), native mobile integrations, carry-over analytics, op-log/CRDT compaction tooling, alternate body-CRDT swap, self-hosted backend distribution. *(AI narrative / MCP integration are out of scope — not planned, not Later.)*

---

## 10. Open Questions

These bound the sync protocol, auth, and privacy design and should be resolved before lock-in (tracked in [Roadmap](05-roadmap.md)):

1. **Sharing model** — DECIDED: a Collection is the designed-in unit of future sharing with **Owner / Collaborator / Viewer** roles. Residual: whether to add finer grains later (e.g. comment-only, per-item permissions) and the exact sync semantics before the data model locks in.
2. **End-to-end encryption** — DECIDED: **deferred non-goal**; MVP is **TLS-only** transport with at-rest as the server's responsibility (keeps server-side search open). Revisit only if a privacy posture later demands it.
3. **AI report narrative** — DECIDED: **out of scope (not planned)**. The report engine is deterministic/offline; there is no MCP surface and no AI-prose path.
4. **Launch hosting posture** — DECIDED: **self-host-first**. The relay ships as one self-contained binary (embedded SQLite + filesystem blob store) sized for a $5-class VPS; Postgres and S3-compatible backends sit behind a storage trait as the scale-up path. A managed/multi-tenant offering is a post-v1 question, not an MVP dependency.
5. **Codename** — "**Daybook**" confirmed (a daybook is a journal of the day's events); lock the design-token namespace to match.
