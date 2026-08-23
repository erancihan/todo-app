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

export type Kind = "task" | "checklist_item";
export type Status = "inbox" | "todo" | "in_progress" | "blocked" | "done" | "dropped";

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
  orderKey: string;
  createdAt: number;
  updatedAt: number;
  dueAt: number | null;
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
  setStatus(id: string, status: Status): Promise<void>;
  toggleDone(id: string): Promise<void>;
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

  generateReport(options: ReportOptions): Promise<Report>;
  commitCarryOver(nodeIds: string[], dayKey: string): Promise<number>;
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
  setStatus(id: string, status: Status) {
    return this.invoke<void>("set_status", { id, status });
  }
  toggleDone(id: string) {
    return this.invoke<void>("toggle_done", { id });
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
  generateReport(options: ReportOptions) {
    return this.invoke<Report>("generate_report", { options });
  }
  commitCarryOver(nodeIds: string[], dayKey: string) {
    return this.invoke<number>("commit_carry_over", { nodeIds, dayKey });
  }
}

/**
 * Browser half: the same `daybook-core`, compiled to wasm32, running in a Worker
 * over sqlite-wasm + OPFS.
 *
 * The Worker is required rather than preferred — see `db-worker.ts`. Calls are
 * RPC'd across and matched by id, so several can be in flight at once.
 */
class WasmEnginePort implements EnginePort {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (ev: MessageEvent) => {
      const { id, ok, result, error } = ev.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    });
    this.worker.addEventListener("error", (ev) => {
      // A worker-level failure strands every in-flight call; fail them all rather
      // than leaving the UI waiting on promises that can never settle.
      const err = new Error(`engine worker failed: ${ev.message}`);
      for (const [, entry] of this.pending) entry.reject(err);
      this.pending.clear();
    });
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args });
    });
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
  setStatus(id: string, status: Status) {
    return this.call<void>("setStatus", id, status);
  }
  toggleDone(id: string) {
    return this.call<void>("toggleDone", id);
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
