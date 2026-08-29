/**
 * The engine port — the single seam between the UI and the Rust core.
 *
 * One interface, two implementations (docs/02-architecture.md §3):
 *
 *   Tauri shell  →  IPC `invoke()`   →  daybook-core compiled natively
 *   Browser PWA  →  Worker + WASM    →  daybook-core compiled to wasm32
 *
 * Nothing above this file knows which one is live, and neither implementation
 * contains any behaviour — both are pure marshalling over the same Rust engine.
 * That is the point: a WebView divergence can never become an *engine* divergence,
 * because there is only one engine.
 *
 * This module is part of the framework-agnostic plain-TS core. Alpine may read it;
 * it must never reach into Alpine.
 */

import {
  channel,
  elect,
  tabId,
  type Call,
  type Changed,
  type Message,
  type Reply,
  type Role,
} from "./tab-lease";

export type Kind = "task" | "checklist_item";

/**
 * A status id. Statuses are user-defined rows now, so this is an opaque string —
 * the built-ins keep the old enum values ("todo", "done", …) as their ids.
 */
export type Status = string;

/** The engine-meaningful part of a status; everything else is presentation. */
export type StatusCategory = "open" | "done" | "cancelled";

export interface StatusView {
  id: string;
  name: string;
  category: StatusCategory;
  color: string;
  sort: number;
  builtIn: boolean;
}

export interface TagView {
  id: string;
  name: string;
  color: string;
}

export interface NodeView {
  id: string;
  parentId: string | null;
  kind: Kind;
  promoted: boolean;
  title: string;
  bodyMd: string;
  status: Status;
  /** Resolved by the engine so the UI never joins the status table itself. */
  statusCategory: StatusCategory;
  orderKey: string;
  createdAt: number;
  updatedAt: number;
  dueAt: number | null;
  /** The civil day this is planned for, as `YYYY-MM-DD`, or null. */
  scheduledFor: string | null;
  /** Canonical repeat rule ("every monday"), or null for a one-off. */
  repeatRule: string | null;
  completedAt: number | null;
  collapsed: boolean;
  /** Depth in the tree, 0 for a root todo. Derived by the engine. */
  depth: number;
  hasChildren: boolean;
  tags: TagView[];
  collectionIds: string[];
}

export interface CollectionView {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  icon: string;
  nodeCount: number;
}

/** Which of the EOD report's four buckets an item landed in (docs/03 §8.2). */
export type Bucket = "created" | "updated" | "completed" | "carried_over";

export type Grouping = "collection" | "tag" | "flat";

/**
 * What the report generator needs that it cannot work out for itself.
 *
 * The window and the UTC offset come from here rather than from Rust because the
 * host is the only side that knows the viewer's local day boundary, DST included
 * (docs/03 §9). Core stays a pure function of these inputs.
 */
export interface ReportOptions {
  fromMs: number;
  toMs: number;
  tzOffsetMinutes: number;
  dateLabel: string;
  groupBy: Grouping;
  dedup: boolean;
  carryOverWindowDays: number;
}

export interface ReportItem {
  nodeId: string;
  title: string;
  status: Status;
  statusCategory: StatusCategory;
  statusName: string;
  bucket: Bucket;
  tags: string[];
  depth: number;
  completedMs: number | null;
  dueMs: number | null;
  promotedInRange: boolean;
  slippedDays: number;
}

export interface ReportSection {
  heading: string;
  items: ReportItem[];
}

export interface Report {
  title: string;
  markdown: string;
  sections: ReportSection[];
  counts: { created: number; updated: number; completed: number; carriedOver: number };
  carriedOverIds: string[];
  duplicated: boolean;
}

/** An attachment, bytes included, as base64 (see `b64::serde_bytes` in Rust). */
export interface BlobView {
  hash: string;
  mime: string;
  /** Base64. Both hosts send it this way — a JSON array of numbers would be six
   *  characters a byte, so a 200 KB screenshot would arrive as a megabyte. */
  bytes: string;
  byteSize: number;
}

export interface BlobMeta {
  hash: string;
  mime: string;
  byteSize: number;
  createdAt: number;
}

export interface EventView {
  id: string;
  nodeId: string;
  type: string;
  fromValue: string | null;
  toValue: string | null;
  occurredAt: string;
  occurredMs: number;
}

/**
 * Everything the UI can ask the engine to do.
 *
 * Deliberately mirrors `crates/core/src/engine.rs` method-for-method. When the
 * engine gains a capability, it shows up here and in both hosts' marshalling
 * layers — and nowhere else.
 */
export interface EnginePort {
  runtime(): Promise<string>;

  listTree(): Promise<NodeView[]>;
  node(id: string): Promise<NodeView | null>;
  createNode(parentId: string | null, title: string, after: string | null): Promise<NodeView>;
  setTitle(id: string, title: string): Promise<void>;
  setBody(id: string, markdown: string): Promise<void>;
  /**
   * `today` is the viewer's civil day (`localDayKey(new Date())`), needed
   * because completing a repeating todo spawns its next occurrence inside the
   * engine's transaction. The spawned occurrence comes back so undo can erase
   * it; `null` when nothing was spawned.
   */
  setStatus(id: string, status: Status, today: string): Promise<NodeView | null>;
  listStatuses(): Promise<StatusView[]>;
  createStatus(name: string, category: StatusCategory, color: string | null): Promise<StatusView>;
  renameStatus(id: string, name: string): Promise<void>;
  setStatusColor(id: string, color: string): Promise<void>;
  deleteStatus(id: string): Promise<void>;
  setTagColor(tagId: string, color: string): Promise<void>;
  /** `null` clears the due date. Milliseconds, UTC. */
  setDue(id: string, dueMs: number | null): Promise<void>;
  /** `null` clears the plan day. A civil `YYYY-MM-DD`, resolved by the host. */
  setScheduled(id: string, day: string | null): Promise<void>;
  /** `null` clears the rule; the engine stores the canonical spelling. */
  setRepeat(id: string, rule: string | null): Promise<void>;
  /** `today` and the return value: see `setStatus`. */
  toggleDone(id: string, today: string): Promise<NodeView | null>;
  promote(id: string): Promise<void>;
  demote(id: string): Promise<void>;
  duplicateNode(id: string, newParent: string | null, after: string | null): Promise<NodeView>;
  restoreNode(id: string): Promise<number>;
  indent(id: string): Promise<void>;
  outdent(id: string): Promise<void>;
  moveNode(id: string, newParent: string | null, after: string | null): Promise<void>;
  deleteNode(id: string): Promise<number>;
  setCollapsed(id: string, collapsed: boolean): Promise<void>;

  addTag(nodeId: string, name: string): Promise<TagView>;
  removeTag(nodeId: string, tagId: string): Promise<void>;
  listTags(): Promise<TagView[]>;

  createCollection(name: string, parentId: string | null): Promise<CollectionView>;
  listCollections(): Promise<CollectionView[]>;
  addToCollection(nodeId: string, collectionId: string): Promise<void>;
  removeFromCollection(nodeId: string, collectionId: string): Promise<void>;

  eventsBetween(fromMs: number, toMs: number): Promise<EventView[]>;
  eventsForNode(nodeId: string): Promise<EventView[]>;

  /** Store bytes; returns their SHA-256, which is the attachment's name. */
  putBlob(mime: string, bytes: Uint8Array): Promise<string>;
  blob(hash: string): Promise<BlobView | null>;
  listBlobs(): Promise<BlobMeta[]>;

  generateReport(options: ReportOptions): Promise<Report>;
  commitCarryOver(nodeIds: string[], dayKey: string): Promise<number>;

  /**
   * Fired when *another* context changed the data.
   *
   * Only the browser port implements it, and only because OPFS forces one engine
   * per origin: the other tabs are calling through this one, so they have to be
   * told when to re-read. The Tauri shell is a single process with a single
   * engine and has nothing to announce.
   */
  onExternalChange?(listener: () => void): void;
}

/**
 * True when running inside the Tauri shell. Tauri v2 injects this before any app
 * script runs, so it is safe to read at module scope.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Native half: every call crosses Tauri IPC into `daybook-core`. */
class TauriEnginePort implements EnginePort {
  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }

  runtime() {
    return this.invoke<string>("runtime");
  }
  listTree() {
    return this.invoke<NodeView[]>("list_tree");
  }
  node(id: string) {
    return this.invoke<NodeView | null>("node", { id });
  }
  createNode(parentId: string | null, title: string, after: string | null) {
    return this.invoke<NodeView>("create_node", { parentId, title, after });
  }
  setTitle(id: string, title: string) {
    return this.invoke<void>("set_title", { id, title });
  }
  setBody(id: string, markdown: string) {
    return this.invoke<void>("set_body", { id, markdown });
  }
  setStatus(id: string, status: Status, today: string) {
    return this.invoke<NodeView | null>("set_status", { id, status, today });
  }
  listStatuses() {
    return this.invoke<StatusView[]>("list_statuses");
  }
  createStatus(name: string, category: StatusCategory, color: string | null) {
    return this.invoke<StatusView>("create_status", { name, category, color });
  }
  renameStatus(id: string, name: string) {
    return this.invoke<void>("rename_status", { id, name });
  }
  setStatusColor(id: string, color: string) {
    return this.invoke<void>("set_status_color", { id, color });
  }
  deleteStatus(id: string) {
    return this.invoke<void>("delete_status", { id });
  }
  setTagColor(tagId: string, color: string) {
    return this.invoke<void>("set_tag_color", { tagId, color });
  }
  setDue(id: string, dueMs: number | null) {
    return this.invoke<void>("set_due", { id, dueMs });
  }
  setScheduled(id: string, day: string | null) {
    return this.invoke<void>("set_scheduled", { id, day });
  }
  setRepeat(id: string, rule: string | null) {
    return this.invoke<void>("set_repeat", { id, rule });
  }
  toggleDone(id: string, today: string) {
    return this.invoke<NodeView | null>("toggle_done", { id, today });
  }
  promote(id: string) {
    return this.invoke<void>("promote", { id });
  }
  demote(id: string) {
    return this.invoke<void>("demote", { id });
  }
  duplicateNode(id: string, newParent: string | null, after: string | null) {
    return this.invoke<NodeView>("duplicate_node", { id, newParent, after });
  }
  restoreNode(id: string) {
    return this.invoke<number>("restore_node", { id });
  }
  indent(id: string) {
    return this.invoke<void>("indent", { id });
  }
  outdent(id: string) {
    return this.invoke<void>("outdent", { id });
  }
  moveNode(id: string, newParent: string | null, after: string | null) {
    return this.invoke<void>("move_node", { id, newParent, after });
  }
  deleteNode(id: string) {
    return this.invoke<number>("delete_node", { id });
  }
  setCollapsed(id: string, collapsed: boolean) {
    return this.invoke<void>("set_collapsed", { id, collapsed });
  }
  addTag(nodeId: string, name: string) {
    return this.invoke<TagView>("add_tag", { nodeId, name });
  }
  removeTag(nodeId: string, tagId: string) {
    return this.invoke<void>("remove_tag", { nodeId, tagId });
  }
  listTags() {
    return this.invoke<TagView[]>("list_tags");
  }
  createCollection(name: string, parentId: string | null) {
    return this.invoke<CollectionView>("create_collection", { name, parentId });
  }
  listCollections() {
    return this.invoke<CollectionView[]>("list_collections");
  }
  addToCollection(nodeId: string, collectionId: string) {
    return this.invoke<void>("add_to_collection", { nodeId, collectionId });
  }
  removeFromCollection(nodeId: string, collectionId: string) {
    return this.invoke<void>("remove_from_collection", { nodeId, collectionId });
  }
  eventsBetween(fromMs: number, toMs: number) {
    return this.invoke<EventView[]>("events_between", { fromMs, toMs });
  }
  eventsForNode(nodeId: string) {
    return this.invoke<EventView[]>("events_for_node", { nodeId });
  }
  putBlob(mime: string, bytes: Uint8Array) {
    // Tauri's IPC serializes a typed array as a JSON number array, which is what
    // the Rust command's `Vec<u8>` expects on the way in.
    return this.invoke<string>("put_blob", { mime, bytes: Array.from(bytes) });
  }
  blob(hash: string) {
    return this.invoke<BlobView | null>("blob", { hash });
  }
  listBlobs() {
    return this.invoke<BlobMeta[]>("list_blobs");
  }
  generateReport(options: ReportOptions) {
    return this.invoke<Report>("generate_report", { options });
  }
  commitCarryOver(nodeIds: string[], dayKey: string) {
    return this.invoke<number>("commit_carry_over", { nodeIds, dayKey });
  }
}

/**
 * Reads. Everything else is treated as a write, which is the safe direction to be
 * wrong in: a needless refresh costs a query, a missed one shows stale data.
 */
const READ_ONLY = new Set([
  "runtime",
  "listTree",
  "node",
  "listTags",
  "listCollections",
  "listStatuses",
  "eventsBetween",
  "eventsForNode",
  "generateReport",
  "blob",
  "listBlobs",
]);

/** How long a follower waits for the leader before giving up on a call. */
const LEADER_TIMEOUT_MS = 10_000;

/**
 * Browser half: the same `daybook-core`, compiled to wasm32, running in a Worker
 * over sqlite-wasm + OPFS.
 *
 * The Worker is required rather than preferred — see `db-worker.ts`. Calls are
 * RPC'd across and matched by id, so several can be in flight at once.
 *
 * ## One engine, many tabs
 *
 * OPFS grants its database lock to a single context per origin, so only one tab
 * can own a worker. This port elects a leader (see `tab-lease.ts`); the leader
 * runs the worker, and followers send the same RPC over a `BroadcastChannel` for
 * the leader to execute. From the controller's side there is no difference — the
 * port is still just an object with async methods.
 */
class WasmEnginePort implements EnginePort {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private readonly tab = tabId();
  private readonly bus = channel();
  private role: Role | null = null;
  /** Resolves once the election has decided what this tab is. */
  private ready: Promise<void>;
  private markReady!: () => void;
  private changeListeners = new Set<() => void>();

  constructor() {
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    this.bus.addEventListener("message", (ev: MessageEvent<Message>) => this.onBus(ev.data));
    elect(
      () => this.becomeLeader(),
      () => this.becomeFollower(),
    );
  }

  private becomeLeader() {
    const promoted = this.role === "follower";
    this.role = "leader";
    if (!this.worker) this.startWorker();
    this.markReady();
    // A promoted tab was reading through the tab that just died, so whatever it
    // is showing may already be behind.
    if (promoted) this.notifyChanged();
  }

  private becomeFollower() {
    this.role = "follower";
    this.markReady();
  }

  private startWorker() {
    const worker = new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (ev: MessageEvent) => {
      const { id, ok, result, error } = ev.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    });
    worker.addEventListener("error", (ev) => {
      // A worker-level failure strands every in-flight call; fail them all rather
      // than leaving the UI waiting on promises that can never settle.
      const err = new Error(`engine worker failed: ${ev.message}`);
      for (const [, entry] of this.pending) entry.reject(err);
      this.pending.clear();
    });
    this.worker = worker;
  }

  /** Register for "another tab changed the data" notifications. */
  onExternalChange(listener: () => void): void {
    this.changeListeners.add(listener);
  }

  private notifyChanged() {
    for (const listener of this.changeListeners) listener();
  }

  private onBus(message: Message) {
    if (message.kind === "changed") {
      if (message.tab !== this.tab) this.notifyChanged();
      return;
    }

    if (message.kind === "call") {
      // Only the leader answers, and only if it still has a worker.
      if (this.role !== "leader") return;
      void this.callWorker(message.method, message.args).then(
        (result) =>
          this.bus.postMessage({
            kind: "reply",
            tab: message.tab,
            id: message.id,
            ok: true,
            result,
          } satisfies Reply),
        (error: Error) =>
          this.bus.postMessage({
            kind: "reply",
            tab: message.tab,
            id: message.id,
            ok: false,
            error: error.message,
          } satisfies Reply),
      );
      return;
    }

    if (message.kind === "reply" && message.tab === this.tab) {
      const entry = this.remote.get(message.id);
      if (!entry) return;
      this.remote.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error ?? "engine call failed"));
    }
  }

  private remote = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private callWorker<T>(method: string, args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker?.postMessage({ id, method, args });
    });
  }

  private callLeader<T>(method: string, args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.remote.delete(id);
        reject(
          new Error(
            "the tab holding the database stopped responding — reload this tab to take it over",
          ),
        );
      }, LEADER_TIMEOUT_MS);
      this.remote.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.bus.postMessage({ kind: "call", tab: this.tab, id, method, args } satisfies Call);
    });
  }

  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    const result =
      this.role === "leader"
        ? await this.callWorker<T>(method, args)
        : await this.callLeader<T>(method, args);

    // Tell the other tabs to re-read. Broadcast from whichever tab issued the
    // call, not from the leader, so a follower's own write does not come back to
    // it as an external change and trigger a second refresh.
    if (!READ_ONLY.has(method)) {
      this.bus.postMessage({ kind: "changed", tab: this.tab } satisfies Changed);
    }
    return result;
  }

  runtime() {
    return this.call<string>("runtime");
  }
  listTree() {
    return this.call<NodeView[]>("listTree");
  }
  node(id: string) {
    return this.call<NodeView | null>("node", id);
  }
  createNode(parentId: string | null, title: string, after: string | null) {
    return this.call<NodeView>("createNode", parentId ?? undefined, title, after ?? undefined);
  }
  setTitle(id: string, title: string) {
    return this.call<void>("setTitle", id, title);
  }
  setBody(id: string, markdown: string) {
    return this.call<void>("setBody", id, markdown);
  }
  setStatus(id: string, status: Status, today: string) {
    return this.call<NodeView | null>("setStatus", id, status, today);
  }
  listStatuses() {
    return this.call<StatusView[]>("listStatuses");
  }
  createStatus(name: string, category: StatusCategory, color: string | null) {
    return this.call<StatusView>("createStatus", name, category, color ?? undefined);
  }
  renameStatus(id: string, name: string) {
    return this.call<void>("renameStatus", id, name);
  }
  setStatusColor(id: string, color: string) {
    return this.call<void>("setStatusColor", id, color);
  }
  deleteStatus(id: string) {
    return this.call<void>("deleteStatus", id);
  }
  setTagColor(tagId: string, color: string) {
    return this.call<void>("setTagColor", tagId, color);
  }
  setDue(id: string, dueMs: number | null) {
    return this.call<void>("setDue", id, dueMs ?? undefined);
  }
  setScheduled(id: string, day: string | null) {
    return this.call<void>("setScheduled", id, day ?? undefined);
  }
  setRepeat(id: string, rule: string | null) {
    return this.call<void>("setRepeat", id, rule ?? undefined);
  }
  toggleDone(id: string, today: string) {
    return this.call<NodeView | null>("toggleDone", id, today);
  }
  promote(id: string) {
    return this.call<void>("promote", id);
  }
  demote(id: string) {
    return this.call<void>("demote", id);
  }
  duplicateNode(id: string, newParent: string | null, after: string | null) {
    return this.call<NodeView>("duplicateNode", id, newParent ?? undefined, after ?? undefined);
  }
  restoreNode(id: string) {
    return this.call<number>("restoreNode", id);
  }
  indent(id: string) {
    return this.call<void>("indent", id);
  }
  outdent(id: string) {
    return this.call<void>("outdent", id);
  }
  moveNode(id: string, newParent: string | null, after: string | null) {
    return this.call<void>("moveNode", id, newParent ?? undefined, after ?? undefined);
  }
  deleteNode(id: string) {
    return this.call<number>("deleteNode", id);
  }
  setCollapsed(id: string, collapsed: boolean) {
    return this.call<void>("setCollapsed", id, collapsed);
  }
  addTag(nodeId: string, name: string) {
    return this.call<TagView>("addTag", nodeId, name);
  }
  removeTag(nodeId: string, tagId: string) {
    return this.call<void>("removeTag", nodeId, tagId);
  }
  listTags() {
    return this.call<TagView[]>("listTags");
  }
  createCollection(name: string, parentId: string | null) {
    return this.call<CollectionView>("createCollection", name, parentId ?? undefined);
  }
  listCollections() {
    return this.call<CollectionView[]>("listCollections");
  }
  addToCollection(nodeId: string, collectionId: string) {
    return this.call<void>("addToCollection", nodeId, collectionId);
  }
  removeFromCollection(nodeId: string, collectionId: string) {
    return this.call<void>("removeFromCollection", nodeId, collectionId);
  }
  eventsBetween(fromMs: number, toMs: number) {
    return this.call<EventView[]>("eventsBetween", fromMs, toMs);
  }
  eventsForNode(nodeId: string) {
    return this.call<EventView[]>("eventsForNode", nodeId);
  }
  putBlob(mime: string, bytes: Uint8Array) {
    return this.call<string>("putBlob", mime, bytes);
  }
  blob(hash: string) {
    return this.call<BlobView | null>("blob", hash);
  }
  listBlobs() {
    return this.call<BlobMeta[]>("listBlobs");
  }
  generateReport(options: ReportOptions) {
    return this.call<Report>("generateReport", options);
  }
  commitCarryOver(nodeIds: string[], dayKey: string) {
    return this.call<number>("commitCarryOver", nodeIds, dayKey);
  }
}

let cached: EnginePort | null = null;

/** The engine port for this host. Resolved once, then reused. */
export function engine(): EnginePort {
  if (!cached) cached = isTauri() ? new TauriEnginePort() : new WasmEnginePort();
  return cached;
}
