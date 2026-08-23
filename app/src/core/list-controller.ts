/**
 * The list controller — mode, focus, and what each keystroke does to the tree.
 *
 * Plain TypeScript, framework-agnostic, and the place all hard list state lives
 * (docs/02-architecture.md ADR-001). Alpine subscribes to it and renders; it never
 * owns any of this. That split is what keeps Alpine swappable if the dense list
 * strains it.
 *
 * The controller never mutates nodes itself — every change goes through the
 * [`EnginePort`] into Rust, then the tree is re-read. Optimistic local mutation
 * would mean list logic in two languages, which is exactly what the architecture
 * is arranged to avoid.
 */

import type {
  CollectionView,
  EnginePort,
  Grouping,
  NodeView,
  Report,
  Status,
  TagView,
} from "./engine-port";
import { fromEvent, resolveKey, shouldPreventDefault, type Action, type Mode } from "./keymap";

export interface ListState {
  mode: Mode;
  nodes: NodeView[];
  /** Id of the focused row, or null when the list is empty. */
  focusedId: string | null;
  /** Set while an engine call is in flight, so the UI can show it. */
  busy: boolean;
  /** Last engine error, surfaced rather than swallowed. */
  error: string | null;
  /** Whether the `?` cheat sheet is open. */
  cheatSheetOpen: boolean;
  /** Whether the Ctrl/Cmd+K palette is open. */
  paletteOpen: boolean;
  /** Whether the `t` tag editor is open. */
  tagEditorOpen: boolean;
  /** Whether the `c` collections picker is open. */
  collectionPickerOpen: boolean;
  /** The `/` search filter. Empty means no filtering. */
  query: string;
  /** Whether the search input has focus. */
  searchOpen: boolean;
  /** Every tag in the account, for the editor's suggestions. */
  allTags: TagView[];
  /** Every collection in the account, for the picker. */
  allCollections: CollectionView[];
  /**
   * The node whose DetailedTodoView is open, if any.
   *
   * Not a mode: LIST and EDIT still mean what they mean inside the detail view.
   * This says *which surface* is rendering, and the list verbs work unchanged
   * because [`visible`] narrows to the node's sub-items while it is set.
   */
  detailId: string | null;
  /** The EOD report, once generated. `null` means the view is closed. */
  report: Report | null;
  /** Which local day the open report covers, as `YYYY-MM-DD`. */
  reportDay: string;
  reportGrouping: Grouping;
  /** Sidebar scope: `null` is "All", otherwise only that collection's items. */
  activeCollectionId: string | null;
  /** Whether the sidebar is down to its icon rail. */
  sidebarCollapsed: boolean;
  /** First key of an in-flight sequence (`d` of `dd`), shown in the mode pill. */
  pendingKey: string | null;
  /** Id of the yanked node, if any — `P` pastes a copy of it. */
  yankedId: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

type Listener = (state: ListState) => void;

/** One reversible step. `label` is what the UI can show ("Undo delete"). */
interface UndoEntry {
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
  /** Row to focus after the step is applied, when it still exists. */
  focusId?: string;
}

/** How many steps to remember. Deep enough to feel safe, shallow enough to bound. */
const UNDO_LIMIT = 50;

/** What the view must do that the controller cannot do itself. */
export interface ListHost {
  /** Focus the body editor on the given node, caret at the end. */
  openEditor(nodeId: string): void;
  /** Leave the editor, returning focus to the list. */
  closeEditor(): void;
  /** Read the editor's current text — used when submitting. */
  editorText(): string;
  /**
   * The DetailedTodoView opened on this node: mount the body editor into its
   * reading column. The detail body is always live rather than a rendered
   * preview with an edit toggle — see the note on `openDetail`.
   */
  openDetail(nodeId: string): void;
  /** Leaving the detail view: flush its editor while `detailId` still points at it. */
  closeDetail(): void;
}

export class ListController {
  private state: ListState = {
    mode: "list",
    nodes: [],
    focusedId: null,
    busy: false,
    error: null,
    cheatSheetOpen: false,
    paletteOpen: false,
    tagEditorOpen: false,
    collectionPickerOpen: false,
    query: "",
    searchOpen: false,
    allTags: [],
    allCollections: [],
    detailId: null,
    report: null,
    reportDay: "",
    reportGrouping: "collection",
    activeCollectionId: null,
    sidebarCollapsed: false,
    pendingKey: null,
    yankedId: null,
    canUndo: false,
    canRedo: false,
  };

  /** Cleared after a short delay so a half-typed sequence does not linger. */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Undo history, as inverse operations.
   *
   * Each entry knows how to undo itself and how to redo itself, rather than
   * snapshotting the tree. Snapshots would be simpler but would fight Phase 2:
   * replacing whole-tree state discards concurrent remote changes, whereas an
   * inverse op is just another local edit that merges like any other.
   *
   * Body text is deliberately absent — CodeMirror owns its own undo history
   * while you are typing, and duplicating it here would give a confusing
   * two-level undo inside the editor.
   */
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  /** The yanked node id. Mirrored into state so the UI can show it. */
  private yanked: string | null = null;

  private listeners = new Set<Listener>();

  constructor(
    private engine: EnginePort,
    private host: ListHost,
  ) {}

  // -- subscription --------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener(this.state);
  }

  private patch(partial: Partial<ListState>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  get snapshot(): ListState {
    return this.state;
  }

  // -- data ----------------------------------------------------------------

  async refresh(): Promise<void> {
    const [nodes, allTags, allCollections] = await Promise.all([
      this.engine.listTree(),
      this.engine.listTags(),
      this.engine.listCollections(),
    ]);
    // Keep focus on the same node across a refresh; fall back to the first row
    // if it vanished (deleted, or moved out of view).
    const focusedId =
      this.state.focusedId && nodes.some((n) => n.id === this.state.focusedId)
        ? this.state.focusedId
        : (nodes[0]?.id ?? null);
    // A scope pointing at a collection that no longer exists would filter the
    // list down to nothing with no visible reason why.
    const activeCollectionId = allCollections.some((c) => c.id === this.state.activeCollectionId)
      ? this.state.activeCollectionId
      : null;
    // Same for a detail view whose todo was deleted — it would render an empty
    // page with no way back except Esc.
    const detailId = nodes.some((n) => n.id === this.state.detailId) ? this.state.detailId : null;
    this.patch({ nodes, allTags, allCollections, focusedId, activeCollectionId, detailId });
  }

  /**
   * Rows currently visible, narrowed in three independent steps: children of a
   * collapsed node are hidden, the sidebar's collection scope is applied, and
   * finally the `/` search. They compose — searching inside a collection means
   * both, not one replacing the other.
   *
   * In the detail view this is the open node's sub-items instead. That is the
   * whole trick behind that screen: `j`, `x`, `a`, `p` and `dd` are not
   * reimplemented there, they act on whatever `visible` currently means.
   */
  get visible(): NodeView[] {
    // Memoised on identity, and this is load-bearing rather than a micro-
    // optimisation. Alpine re-runs `x-for` whenever the array it iterates is a
    // *different object*, so recomputing here handed it a fresh array on every
    // `patch` — including a bare focus move — and it rebuilt every row's DOM to
    // change one highlight. Measured at 2000 todos that was ~12s per `j`.
    // Returning the same array when nothing that shapes it has changed turns a
    // keypress back into two class updates.
    const key: unknown[] = [
      this.state.nodes,
      this.state.detailId,
      this.state.activeCollectionId,
      this.state.query,
    ];
    const cached = this.visibleCache;
    if (cached && cached.key.length === key.length && cached.key.every((v, i) => v === key[i])) {
      return cached.rows;
    }

    const rows = this.computeVisible();
    this.visibleCache = { key, rows };
    return rows;
  }

  private visibleCache: { key: unknown[]; rows: NodeView[] } | null = null;

  /**
   * Done/total per parent, computed once per tree rather than once per row.
   *
   * The view needs this for every row's rollup badge. Reading it by filtering
   * the whole node list inside the row binding made rendering O(n²) — at 2000
   * todos that is four million comparisons per keystroke, which is exactly
   * where the list stopped being usable.
   */
  get childCounts(): Map<string, { done: number; total: number }> {
    if (this.childCountsCache?.nodes === this.state.nodes) return this.childCountsCache.counts;

    const counts = new Map<string, { done: number; total: number }>();
    for (const node of this.state.nodes) {
      const parent = node.parentId ?? null;
      if (!parent) continue;
      const entry = counts.get(parent) ?? { done: 0, total: 0 };
      entry.total += 1;
      if (node.status === "done") entry.done += 1;
      counts.set(parent, entry);
    }
    this.childCountsCache = { nodes: this.state.nodes, counts };
    return counts;
  }

  private childCountsCache: {
    nodes: NodeView[];
    counts: Map<string, { done: number; total: number }>;
  } | null = null;

  private computeVisible(): NodeView[] {
    if (this.state.detailId) return this.applyCollapse(this.subtreeOf(this.state.detailId));

    let rows = this.applyCollapse(this.state.nodes);
    if (this.state.activeCollectionId) rows = this.applyCollectionScope(rows);
    if (this.state.query.trim()) rows = this.applyFilter(rows);
    return rows;
  }

  /** Every descendant of `id`, in tree order, excluding `id` itself. */
  private subtreeOf(id: string): NodeView[] {
    const nodes = this.state.nodes;
    const start = nodes.findIndex((n) => n.id === id);
    if (start === -1) return [];
    const rootDepth = nodes[start]!.depth;
    const out: NodeView[] = [];
    for (let i = start + 1; i < nodes.length && nodes[i]!.depth > rootDepth; i += 1) {
      out.push(nodes[i]!);
    }
    return out;
  }

  /** The node whose detail view is open, or null. */
  get detailNode(): NodeView | null {
    return this.state.nodes.find((n) => n.id === this.state.detailId) ?? null;
  }

  /** The detail node's parent, for the backlink chip (docs/04 §6). */
  get detailParent(): NodeView | null {
    const parent = this.detailNode?.parentId;
    return parent ? (this.state.nodes.find((n) => n.id === parent) ?? null) : null;
  }

  private applyCollapse(nodes: NodeView[]): NodeView[] {
    const out: NodeView[] = [];
    let hiddenBelowDepth: number | null = null;

    for (const node of nodes) {
      if (hiddenBelowDepth !== null) {
        if (node.depth > hiddenBelowDepth) continue;
        hiddenBelowDepth = null;
      }
      out.push(node);
      if (node.collapsed && node.hasChildren) hiddenBelowDepth = node.depth;
    }
    return out;
  }

  /**
   * Keep matching rows and every ancestor of a match.
   *
   * Dropping the ancestors would leave children floating at a depth with no
   * visible parent, which reads as corruption rather than as a filter.
   */
  private keepWithAncestors(rows: NodeView[], matches: (n: NodeView) => boolean): NodeView[] {
    const keep = new Set<string>();
    const byId = new Map(this.state.nodes.map((n) => [n.id, n]));
    for (const node of this.state.nodes) {
      if (!matches(node)) continue;
      keep.add(node.id);
      let parent = node.parentId;
      while (parent && !keep.has(parent)) {
        keep.add(parent);
        parent = byId.get(parent)?.parentId ?? null;
      }
    }
    return rows.filter((n) => keep.has(n.id));
  }

  private applyFilter(nodes: NodeView[]): NodeView[] {
    const q = this.state.query.trim().toLowerCase();
    return this.keepWithAncestors(
      nodes,
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.bodyMd.toLowerCase().includes(q) ||
        n.tags.some((t) => t.name.toLowerCase().includes(q)),
    );
  }

  /**
   * Narrow to one collection.
   *
   * Membership is per-node, not inherited, so a sub-item filed under "Work"
   * shows even when its parent is not — with the parent kept for context, the
   * same way search behaves.
   */
  private applyCollectionScope(nodes: NodeView[]): NodeView[] {
    const id = this.state.activeCollectionId;
    if (!id) return nodes;
    return this.keepWithAncestors(nodes, (n) => n.collectionIds.includes(id));
  }

  /**
   * Open (not done, not dropped) item counts per collection id, plus the total
   * under the `ALL_SCOPE` key.
   *
   * Computed here rather than read from `CollectionView.nodeCount`, which counts
   * every member including finished ones — a badge showing work left is the
   * useful one, and the controller already holds the whole tree.
   */
  get openCounts(): Map<string | null, number> {
    const counts = new Map<string | null, number>();
    let all = 0;
    for (const node of this.state.nodes) {
      if (node.status === "done" || node.status === "dropped") continue;
      all += 1;
      for (const id of node.collectionIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    counts.set(null, all);
    return counts;
  }

  private get focused(): NodeView | null {
    return this.state.nodes.find((n) => n.id === this.state.focusedId) ?? null;
  }

  private focusByOffset(offset: number) {
    const rows = this.visible;
    if (rows.length === 0) return;
    const current = rows.findIndex((n) => n.id === this.state.focusedId);
    const next = Math.min(Math.max((current === -1 ? 0 : current) + offset, 0), rows.length - 1);
    this.patch({ focusedId: rows[next]!.id });
  }

  focus(id: string) {
    this.patch({ focusedId: id });
  }

  // -- detail view ---------------------------------------------------------

  /**
   * Open the DetailedTodoView for a node (docs/04 §8, Screen 3).
   *
   * Focus moves to the first sub-item so `j`/`k` are immediately useful; with no
   * sub-items there is nothing in the checklist to focus and it goes null, which
   * every verb already tolerates.
   */
  openDetail(id?: string) {
    const target = id ?? this.state.focusedId;
    if (!target || !this.state.nodes.some((n) => n.id === target)) return;
    // Flush *before* `detailId` moves. `saveDetailBody` reads it live, so
    // flushing afterwards would file the old todo's text under the new one.
    this.host.closeEditor();
    if (this.state.detailId) this.host.closeDetail();

    this.patch({ detailId: target, mode: "list" });
    this.patch({ focusedId: this.visible[0]?.id ?? null });
    this.host.openDetail(target);
  }

  /** Back to the list, with the node you were looking at focused. */
  closeDetail() {
    const wasOpen = this.state.detailId;
    if (!wasOpen) return;
    this.host.closeEditor();
    this.host.closeDetail();
    this.patch({ detailId: null, mode: "list", focusedId: wasOpen });
  }

  // -- EOD report ----------------------------------------------------------

  /**
   * Generate the report for a local day and open the view.
   *
   * The window is computed here, in the host, because this is the only side that
   * knows the viewer's timezone — including DST, which is why the offset is read
   * from the *day being reported on* rather than from now. Core takes the window
   * as given (docs/03 §9).
   */
  async openReport(day?: string, grouping?: Grouping): Promise<void> {
    const dayKey = day ?? localDayKey(new Date());
    const groupBy = grouping ?? this.state.reportGrouping;

    const start = new Date(`${dayKey}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    // `getTimezoneOffset` is minutes to ADD to local to reach UTC, so it is the
    // negation of what the report wants.
    const tzOffsetMinutes = -start.getTimezoneOffset();

    this.host.closeEditor();
    if (this.state.detailId) this.host.closeDetail();

    await this.run(async () => {
      const report = await this.engine.generateReport({
        fromMs: start.getTime(),
        toMs: end.getTime(),
        tzOffsetMinutes,
        dateLabel: dayKey,
        groupBy,
        dedup: false,
        carryOverWindowDays: 7,
      });
      // Only today's report writes. Browsing back through history is reading,
      // and letting it append `carried_over` events would inflate every stale
      // item's slipped count a little more each time someone scrolled through
      // last week. `slippedDays` therefore means "how many daily reports have
      // carried this forward", not "how many calendar days it has been open" —
      // a day you never opened Daybook does not count against you.
      if (report.carriedOverIds.length > 0 && dayKey === localDayKey(new Date())) {
        await this.engine.commitCarryOver(report.carriedOverIds, dayKey);
      }
      this.state.report = report;
      this.state.reportDay = dayKey;
      this.state.reportGrouping = groupBy;
      this.state.detailId = null;
      this.state.mode = "list";
    });
  }

  closeReport() {
    if (this.state.report) this.patch({ report: null });
  }

  /** Step the reported day by `days`, keeping the view open. */
  async shiftReportDay(days: number): Promise<void> {
    if (!this.state.reportDay) return;
    const date = new Date(`${this.state.reportDay}T00:00:00`);
    date.setDate(date.getDate() + days);
    await this.openReport(localDayKey(date));
  }

  // -- sidebar -------------------------------------------------------------

  /** Scope the list to one collection, or to everything when given `null`. */
  setActiveCollection(id: string | null) {
    this.patch({ activeCollectionId: id });
    // Focus follows the scope: leaving it on a row that just went out of view
    // makes the next `j` jump somewhere unrelated.
    const rows = this.visible;
    if (!rows.some((n) => n.id === this.state.focusedId)) {
      this.patch({ focusedId: rows[0]?.id ?? null });
    }
  }

  setSidebarCollapsed(collapsed: boolean) {
    this.patch({ sidebarCollapsed: collapsed });
  }

  /**
   * The sidebar's rows, in the order the `1`…`9` shortcuts address them —
   * "All" first, then the collections as the engine ordered them (by name).
   */
  get sidebarRows(): Array<{ id: string | null; name: string; color: string; count: number }> {
    const counts = this.openCounts;
    return [
      { id: null, name: "All", color: "", count: counts.get(null) ?? 0 },
      ...this.state.allCollections.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        count: counts.get(c.id) ?? 0,
      })),
    ];
  }

  /** Run an engine call, refresh, and surface any failure instead of hiding it. */
  private async run(work: () => Promise<unknown>): Promise<void> {
    this.patch({ busy: true, error: null });
    try {
      await work();
      await this.refresh();
    } catch (e) {
      this.patch({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.patch({ busy: false });
    }
  }

  // -- mode ----------------------------------------------------------------

  enterEdit(id?: string) {
    const target = id ?? this.state.focusedId;
    if (!target) return;
    this.patch({ mode: "edit", focusedId: target });
    this.host.openEditor(target);
  }

  /** `Esc` — keep the text, drop the caret. Autosave already ran. */
  async exitEdit(): Promise<void> {
    const id = this.state.focusedId;
    if (id) await this.saveBody(id);
    this.patch({ mode: "list" });
    this.host.closeEditor();
    if (id) await this.discardIfEmpty(id);
  }

  /**
   * Delete a node that was created but never filled in.
   *
   * Capture opens a row *before* you type — that is what makes it feel instant —
   * so walking away from one would otherwise leave a permanent empty node, and
   * streak mode produces one after every single submit. Nothing here is
   * recoverable content: no title, no body, no children, no tags, no collection.
   */
  private async discardIfEmpty(id: string): Promise<void> {
    const node = this.state.nodes.find((n) => n.id === id);
    if (!node) return;

    // The active scope's collection does not count as content: `createInScope`
    // put it there, the user did not. Counting it would make every capture made
    // inside a collection un-discardable, bringing back the blank-row litter.
    const scope = this.state.activeCollectionId;
    const filedByHand = node.collectionIds.filter((id) => id !== scope);

    const empty =
      !node.title.trim() &&
      !node.bodyMd.trim() &&
      !node.hasChildren &&
      node.tags.length === 0 &&
      filedByHand.length === 0 &&
      node.status !== "done";
    if (!empty) return;

    // Move focus off the row first so it does not land on a deleted node.
    const rows = this.visible;
    const index = rows.findIndex((n) => n.id === id);
    const neighbour = rows[index - 1]?.id ?? rows[index + 1]?.id ?? null;

    await this.run(async () => {
      await this.engine.deleteNode(id);
      this.state.focusedId = neighbour;
    });
  }

  /**
   * Create a node, filed into the active collection scope.
   *
   * Without this, capturing while scoped to "Work" creates a node that is not in
   * "Work" — so it vanishes from the list the instant it appears. Every creation
   * verb goes through here for that reason.
   */
  private async createInScope(parentId: string | null, after: string | null): Promise<NodeView> {
    const created = await this.engine.createNode(parentId, "", after);
    const scope = this.state.activeCollectionId;
    if (scope) await this.engine.addToCollection(created.id, scope);
    return created;
  }

  private async saveBody(id: string): Promise<void> {
    return this.saveBodyText(id, this.host.editorText());
  }

  /**
   * Persist body text for a node.
   *
   * Takes the id explicitly and defaults to the *current* focus rather than
   * capturing one: the editor is a single long-lived instance moved between rows,
   * so a callback that closed over the id it was created with would keep writing
   * to the first node the user ever edited.
   */
  async saveBodyText(id: string | null, text: string): Promise<void> {
    const target = id ?? this.state.focusedId;
    if (!target) return;
    const node = this.state.nodes.find((n) => n.id === target);
    if (!node || node.bodyMd === text) return;
    await this.run(() => this.engine.setBody(target, text));
  }

  /** Autosave hook for the editor — always writes to whatever row has focus. */
  saveFocusedBody(text: string): void {
    void this.saveBodyText(null, text);
  }

  /**
   * Autosave hook for the detail view's own editor.
   *
   * It cannot share `saveFocusedBody`: inside the detail view focus is on a
   * *sub-item*, so routing the main body through it would file the todo's body
   * into whichever child happened to be highlighted. Reads `detailId` live for
   * the same reason `saveFocusedBody` reads `focusedId` live — a callback that
   * captured the id would keep writing to the first todo ever opened.
   */
  saveDetailBody(text: string): void {
    // No open detail means a late flush from an editor that is being torn down.
    // Falling through to `saveBodyText`'s focused-row default would write the
    // body of the todo you just left into the row you just landed on.
    if (!this.state.detailId) return;
    void this.saveBodyText(this.state.detailId, text);
  }

  /**
   * `Ctrl/Cmd+Enter` — commit the body, drop to LIST, and open a fresh empty
   * capture line below (the "streak mode" that makes ten todos zero-mouse).
   */
  async submit(): Promise<void> {
    const id = this.state.focusedId;
    if (!id) return;
    await this.saveBody(id);

    const current = this.state.nodes.find((n) => n.id === id);
    this.patch({ mode: "list" });
    this.host.closeEditor();

    // Submitting an empty row means "I'm done", not "give me another empty row".
    // Opening a fresh one here is how a streak leaves a trail of blank nodes.
    if (!current?.title.trim() && !current?.bodyMd.trim()) {
      await this.discardIfEmpty(id);
      return;
    }

    await this.run(async () => {
      const created = await this.createInScope(current?.parentId ?? null, id);
      this.state.focusedId = created.id;
    });
    // Streak: the next line is already open and waiting.
    this.enterEdit(this.state.focusedId ?? undefined);
  }

  // -- keyboard ------------------------------------------------------------

  /**
   * Handle a key press. Returns true when the controller consumed it, so the
   * caller knows whether to let the browser proceed.
   *
   * `newline` and `caret-move` are never consumed: those belong to CodeMirror and
   * the browser's own input handling, and stealing them is what breaks IME
   * composition and the mobile soft keyboard.
   */
  handleKey(event: KeyboardEvent): boolean {
    const resolution = resolveKey(fromEvent(event), this.state.mode, this.state.pendingKey);

    if (resolution.kind === "sequence-start") {
      event.preventDefault();
      this.beginSequence(resolution.key);
      return true;
    }

    // Any resolved key ends an in-flight sequence.
    if (this.state.pendingKey) this.clearSequence();

    if (resolution.kind === "unbound") return false;
    const { action } = resolution;
    if (action === "newline" || action === "caret-move") return false;

    if (shouldPreventDefault(action)) event.preventDefault();
    void this.dispatch(action, event.key);
    return true;
  }

  private beginSequence(key: string) {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.patch({ pendingKey: key });
    // A stuck `d` would silently turn the next `d` into a delete minutes later.
    this.pendingTimer = setTimeout(() => this.clearSequence(), 1500);
  }

  private clearSequence() {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.state.pendingKey) this.patch({ pendingKey: null });
  }

  /**
   * Run a verb.
   *
   * `arg` carries the raw key for the few actions that are a family rather than
   * a single verb — today only `select-collection`, where `1`…`9` all resolve to
   * the same action and the digit says which row. Widening [`Action`] into a
   * payload-carrying union would touch every case for the sake of one.
   */
  async dispatch(action: Action, arg?: string): Promise<void> {
    const node = this.focused;

    switch (action) {
      // -- navigation
      case "focus-next":
        return this.focusByOffset(1);
      case "focus-prev":
        return this.focusByOffset(-1);
      case "jump-first":
        return this.patch({ focusedId: this.visible[0]?.id ?? null });
      case "jump-last": {
        const rows = this.visible;
        return this.patch({ focusedId: rows[rows.length - 1]?.id ?? null });
      }
      case "collapse-or-parent": {
        if (!node) return;
        // Collapse if it can collapse; otherwise jump to the parent. Two useful
        // behaviours on one key, disambiguated by state rather than a modifier.
        if (node.hasChildren && !node.collapsed) {
          return this.run(() => this.engine.setCollapsed(node.id, true));
        }
        if (node.parentId) this.patch({ focusedId: node.parentId });
        return;
      }
      case "expand-or-child": {
        if (!node) return;
        if (node.hasChildren && node.collapsed) {
          return this.run(() => this.engine.setCollapsed(node.id, false));
        }
        if (node.hasChildren) this.focusByOffset(1);
        return;
      }

      // -- editing
      case "edit":
        return this.enterEdit();
      case "exit-edit":
        return void this.exitEdit();
      case "submit":
        return void this.submit();

      // -- creation
      case "quick-add":
        return this.run(async () => {
          // After the *last* top-level row, not before the first. `n` was the one
          // creation verb that grew upward, so a capture streak came out in
          // reverse reading order while `o`, `a` and submit all went downward.
          // `?? null` on both sides of every parent comparison in this file: the
          // wasm boundary is pinned to emit `null` (see `wasm.rs::to_js`), but a
          // root read as `undefined` would make this filter quietly return
          // nothing and put the capture at the top instead of the bottom.
          const last = this.state.nodes.filter((n) => (n.parentId ?? null) === null).at(-1) ?? null;
          const created = await this.createInScope(null, last?.id ?? null);
          this.state.focusedId = created.id;
        }).then(() => this.enterEdit(this.state.focusedId ?? undefined));
      case "new-sibling-below":
        return this.run(async () => {
          const created = await this.createInScope(node?.parentId ?? null, node?.id ?? null);
          this.state.focusedId = created.id;
        }).then(() => this.enterEdit(this.state.focusedId ?? undefined));
      case "new-sibling-above":
        return this.run(async () => {
          // "Above" means "before this one", i.e. after this node's predecessor.
          const siblings = this.state.nodes.filter(
            (n) => (n.parentId ?? null) === (node?.parentId ?? null),
          );
          const index = siblings.findIndex((n) => n.id === node?.id);
          const after = index > 0 ? siblings[index - 1]!.id : null;
          const created = await this.createInScope(node?.parentId ?? null, after);
          this.state.focusedId = created.id;
        }).then(() => this.enterEdit(this.state.focusedId ?? undefined));
      case "new-subitem":
        if (!node) return;
        return this.run(async () => {
          const created = await this.createInScope(node.id, null);
          this.state.focusedId = created.id;
        }).then(() => this.enterEdit(this.state.focusedId ?? undefined));

      // -- verbs
      case "toggle-done":
        if (!node) return;
        this.remember({
          label: "toggle done",
          focusId: node.id,
          undo: () => this.engine.toggleDone(node.id),
          redo: () => this.engine.toggleDone(node.id),
        });
        return this.run(() => this.engine.toggleDone(node.id));
      case "promote":
        if (!node) return;
        if (node.promoted) return;
        this.remember({
          label: "promote",
          focusId: node.id,
          undo: () => this.engine.demote(node.id),
          redo: () => this.engine.promote(node.id),
        });
        return this.run(() => this.engine.promote(node.id));
      case "indent":
      case "outdent": {
        if (!node) return;
        // The inverse of a structural move is "put it back exactly where it
        // was", which needs the old parent *and* the old preceding sibling —
        // outdent/indent alone would not restore the position within the level.
        const previousParent = node.parentId;
        const siblings = this.state.nodes.filter((n) => n.parentId === node.parentId);
        const index = siblings.findIndex((n) => n.id === node.id);
        const previousAfter = index > 0 ? siblings[index - 1]!.id : null;

        this.remember({
          label: action,
          focusId: node.id,
          undo: () => this.engine.moveNode(node.id, previousParent, previousAfter),
          redo: () =>
            action === "indent" ? this.engine.indent(node.id) : this.engine.outdent(node.id),
        });
        return this.run(() =>
          action === "indent" ? this.engine.indent(node.id) : this.engine.outdent(node.id),
        );
      }
      case "delete":
        if (!node) return;
        this.remember({
          label: "delete",
          focusId: node.id,
          undo: () => this.engine.restoreNode(node.id),
          redo: () => this.engine.deleteNode(node.id),
        });
        return this.run(() => this.engine.deleteNode(node.id));

      // -- history
      case "undo":
        return this.undo();
      case "redo":
        return this.redo();

      // -- yank / paste
      case "yank":
        if (!node) return;
        // Remembers the *id*, not a snapshot, so pasting copies the node as it
        // stands now. Vim would paste the yanked text; here the useful reading of
        // "copy this todo" is the live one.
        this.yanked = node.id;
        return this.patch({ yankedId: node.id });
      case "paste": {
        if (!this.yanked) return;
        const source = this.yanked;
        return this.run(async () => {
          const copy = await this.engine.duplicateNode(
            source,
            node?.parentId ?? null,
            node?.id ?? null,
          );
          this.state.focusedId = copy.id;
          this.remember({
            label: "paste",
            undo: () => this.engine.deleteNode(copy.id),
            redo: () => this.engine.restoreNode(copy.id),
          });
        });
      }

      // -- the two axes
      case "open-tags":
        if (!node) return;
        return this.patch({ tagEditorOpen: true, collectionPickerOpen: false });
      case "open-collections":
        if (!node) return;
        return this.patch({ collectionPickerOpen: true, tagEditorOpen: false });

      // -- overlays
      case "focus-search":
        return this.patch({ searchOpen: true });

      // -- surfaces
      case "generate-report":
        // A toggle: the same chord that opens it puts it away.
        if (this.state.report) return this.closeReport();
        return this.openReport();
      case "open-detail":
        return this.openDetail();
      case "toggle-sidebar":
        return this.setSidebarCollapsed(!this.state.sidebarCollapsed);
      case "select-collection": {
        // `arg` is the digit that was pressed; 1 addresses the first row ("All").
        const index = Number(arg) - 1;
        const row = this.sidebarRows[index];
        // Out of range is a no-op, not a reset to "All": pressing `7` with three
        // collections should do nothing rather than silently widen the scope.
        if (!row) return;
        return this.setActiveCollection(row.id);
      }

      case "cheat-sheet":
        return this.patch({ cheatSheetOpen: !this.state.cheatSheetOpen });
      case "command-palette":
        return this.patch({ paletteOpen: !this.state.paletteOpen });
      case "clear":
        // Esc unwinds one layer at a time: overlays, then the search, then
        // nothing. Clearing everything at once loses a filter the user is still
        // using just because they dismissed a popover.
        if (
          this.state.cheatSheetOpen ||
          this.state.paletteOpen ||
          this.state.tagEditorOpen ||
          this.state.collectionPickerOpen
        ) {
          return this.closeOverlays();
        }
        if (this.state.query || this.state.searchOpen) {
          return this.patch({ query: "", searchOpen: false });
        }
        if (this.state.report) return this.closeReport();
        if (this.state.detailId) return this.closeDetail();
        return this.patch({ error: null });

      default:
        // Every action is wired. A `never` here would be nicer, but the union is
        // shared with the palette, which dispatches by string id.
        return;
    }
  }

  // -- direct actions used by the palette and mouse ------------------------

  async setTitle(id: string, title: string): Promise<void> {
    return this.run(() => this.engine.setTitle(id, title));
  }

  /**
   * Move a node under `parentId`, positioned after `afterId` (null = first).
   *
   * The mouse counterpart to `Tab`/`Shift+Tab` and `o`/`O`/`a`. Undo restores
   * both the old parent *and* the old preceding sibling, because a structural
   * move that only remembers the parent puts the row back at the wrong height.
   */
  async moveTo(id: string, parentId: string | null, afterId: string | null): Promise<void> {
    const node = this.state.nodes.find((n) => n.id === id);
    if (!node) return;

    // Refuse to drop a node inside its own subtree — the engine would build a
    // cycle and the row would vanish from the tree walk.
    if (parentId && this.isAncestorOf(id, parentId)) return;

    const previousParent = node.parentId ?? null;
    const siblings = this.state.nodes.filter((n) => (n.parentId ?? null) === previousParent);
    const index = siblings.findIndex((n) => n.id === id);
    const previousAfter = index > 0 ? siblings[index - 1]!.id : null;
    if (previousParent === parentId && previousAfter === afterId) return;

    this.remember({
      label: "move",
      focusId: id,
      undo: () => this.engine.moveNode(id, previousParent, previousAfter),
      redo: () => this.engine.moveNode(id, parentId, afterId),
    });
    return this.run(() => this.engine.moveNode(id, parentId, afterId));
  }

  /** Whether `id` is an ancestor of `candidate` (or the same node). */
  isAncestorOf(id: string, candidate: string): boolean {
    if (id === candidate) return true;
    let cursor: string | null | undefined = this.state.nodes.find(
      (n) => n.id === candidate,
    )?.parentId;
    while (cursor) {
      if (cursor === id) return true;
      cursor = this.state.nodes.find((n) => n.id === cursor)?.parentId;
    }
    return false;
  }

  /**
   * Set or clear a due date, undoably.
   *
   * The date arrives as a local `YYYY-MM-DD` from an `<input type="date">` and is
   * resolved to end-of-day local, because "due Friday" means "by the end of
   * Friday", not "at midnight as Friday begins".
   */
  async setDue(id: string, day: string | null): Promise<void> {
    const node = this.state.nodes.find((n) => n.id === id);
    const previous = node?.dueAt ?? null;
    const next = day ? endOfLocalDay(day) : null;
    if (previous === next) return;

    this.remember({
      label: "due date",
      focusId: id,
      undo: () => this.engine.setDue(id, previous),
      redo: () => this.engine.setDue(id, next),
    });
    return this.run(() => this.engine.setDue(id, next));
  }

  /**
   * Set an explicit status.
   *
   * `x` only ever swings between `todo` and `done`, so until the detail view's
   * meta rail there was no way to reach `in_progress`, `blocked` or `dropped`
   * from the UI at all — the engine supported them and nothing offered them.
   */
  async setStatus(id: string, status: Status): Promise<void> {
    const node = this.state.nodes.find((n) => n.id === id);
    const previous = node?.status;
    if (previous && previous !== status) {
      this.remember({
        label: "status",
        focusId: id,
        undo: () => this.engine.setStatus(id, previous),
        redo: () => this.engine.setStatus(id, status),
      });
    }
    return this.run(() => this.engine.setStatus(id, status));
  }

  async addTag(id: string, name: string): Promise<void> {
    return this.run(() => this.engine.addTag(id, name));
  }

  async removeTag(id: string, tagId: string): Promise<void> {
    return this.run(() => this.engine.removeTag(id, tagId));
  }

  /** Add or remove the focused node's membership of a collection. */
  async toggleCollection(nodeId: string, collectionId: string): Promise<void> {
    const node = this.state.nodes.find((n) => n.id === nodeId);
    const isMember = node?.collectionIds.includes(collectionId) ?? false;
    return this.run(() =>
      isMember
        ? this.engine.removeFromCollection(nodeId, collectionId)
        : this.engine.addToCollection(nodeId, collectionId),
    );
  }

  /** Create a collection and put the focused node in it straight away. */
  async createCollection(name: string, nodeId?: string): Promise<void> {
    return this.run(async () => {
      const created = await this.engine.createCollection(name, null);
      if (nodeId) await this.engine.addToCollection(nodeId, created.id);
    });
  }

  setQuery(query: string) {
    this.patch({ query });
  }

  // -- undo / redo ---------------------------------------------------------

  /** Record a step. Any new action invalidates the redo branch, as usual. */
  private remember(entry: UndoEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.patch({ canUndo: true, canRedo: false });
  }

  private syncHistoryFlags() {
    this.patch({
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    });
  }

  async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) return;
    await this.run(async () => {
      await entry.undo();
      if (entry.focusId) this.state.focusedId = entry.focusId;
    });
    this.redoStack.push(entry);
    this.syncHistoryFlags();
  }

  async redo(): Promise<void> {
    const entry = this.redoStack.pop();
    if (!entry) return;
    await this.run(async () => {
      await entry.redo();
      if (entry.focusId) this.state.focusedId = entry.focusId;
    });
    this.undoStack.push(entry);
    this.syncHistoryFlags();
  }

  closeOverlays() {
    // An overlay's input holds DOM focus while it is open, so closing one drops
    // focus onto `<body>` and the next keystroke reaches nothing. Hand it back
    // to the list, which is where the caret was before the overlay opened.
    const wasOpen =
      this.state.cheatSheetOpen ||
      this.state.paletteOpen ||
      this.state.tagEditorOpen ||
      this.state.collectionPickerOpen;
    if (wasOpen) this.host.closeEditor();

    this.patch({
      cheatSheetOpen: false,
      paletteOpen: false,
      tagEditorOpen: false,
      collectionPickerOpen: false,
    });
  }

  /** The node the overlays act on. */
  get focusedNode(): NodeView | null {
    return this.focused;
  }
}

/**
 * `YYYY-MM-DD` for a Date in the *local* timezone.
 *
 * Not `toISOString().slice(0, 10)`: that converts to UTC first, so anyone east
 * of Greenwich in the evening — or west of it in the morning — would get
 * yesterday's or tomorrow's report without being told.
 */
export function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The last millisecond of a local `YYYY-MM-DD`. */
export function endOfLocalDay(day: string): number {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return date.getTime() - 1;
}

/** A due timestamp back to the `YYYY-MM-DD` an `<input type="date">` wants. */
export function dueDayValue(ms: number | null): string {
  return ms ? localDayKey(new Date(ms)) : "";
}
