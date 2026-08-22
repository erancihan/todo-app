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

import type { CollectionView, EnginePort, NodeView, TagView } from "./engine-port";
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
  /** First key of an in-flight sequence (`d` of `dd`), shown in the mode pill. */
  pendingKey: string | null;
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
    pendingKey: null,
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
    this.patch({ nodes, allTags, allCollections, focusedId });
  }

  /**
   * Rows currently visible: children of a collapsed node are hidden, and when a
   * search is active only matches and their ancestors survive.
   */
  get visible(): NodeView[] {
    const collapsed = this.applyCollapse(this.state.nodes);
    return this.state.query.trim() ? this.applyFilter(collapsed) : collapsed;
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
  private applyFilter(nodes: NodeView[]): NodeView[] {
    const q = this.state.query.trim().toLowerCase();
    const matches = (n: NodeView) =>
      n.title.toLowerCase().includes(q) ||
      n.bodyMd.toLowerCase().includes(q) ||
      n.tags.some((t) => t.name.toLowerCase().includes(q));

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
    return nodes.filter((n) => keep.has(n.id));
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

    const empty =
      !node.title.trim() &&
      !node.bodyMd.trim() &&
      !node.hasChildren &&
      node.tags.length === 0 &&
      node.collectionIds.length === 0 &&
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
      const created = await this.engine.createNode(current?.parentId ?? null, "", id);
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
    void this.dispatch(action);
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

  async dispatch(action: Action): Promise<void> {
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
          const created = await this.engine.createNode(null, "", null);
          this.state.focusedId = created.id;
        }).then(() => this.enterEdit(this.state.focusedId ?? undefined));
      case "new-sibling-below":
        return this.run(async () => {
          const created = await this.engine.createNode(
            node?.parentId ?? null,
            "",
            node?.id ?? null,
          );
          this.state.focusedId = created.id;
        }).then(() => this.enterEdit(this.state.focusedId ?? undefined));
      case "new-sibling-above":
        return this.run(async () => {
          // "Above" means "before this one", i.e. after this node's predecessor.
          const siblings = this.state.nodes.filter(
            (n) => n.parentId === (node?.parentId ?? null),
          );
          const index = siblings.findIndex((n) => n.id === node?.id);
          const after = index > 0 ? siblings[index - 1]!.id : null;
          const created = await this.engine.createNode(node?.parentId ?? null, "", after);
          this.state.focusedId = created.id;
        }).then(() => this.enterEdit(this.state.focusedId ?? undefined));
      case "new-subitem":
        if (!node) return;
        return this.run(async () => {
          const created = await this.engine.createNode(node.id, "", null);
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
        return this.patch({ error: null });

      default:
        // Still unwired: undo/redo and yank/paste. Deliberately inert rather
        // than silently wrong.
        return;
    }
  }

  // -- direct actions used by the palette and mouse ------------------------

  async setTitle(id: string, title: string): Promise<void> {
    return this.run(() => this.engine.setTitle(id, title));
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
