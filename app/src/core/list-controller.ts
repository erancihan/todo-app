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

import type { EnginePort, NodeView } from "./engine-port";
import { fromEvent, resolve, shouldPreventDefault, type Action, type Mode } from "./keymap";

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
}

type Listener = (state: ListState) => void;

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
  };

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
    const nodes = await this.engine.listTree();
    // Keep focus on the same node across a refresh; fall back to the first row
    // if it vanished (deleted, or moved out of view).
    const focusedId =
      this.state.focusedId && nodes.some((n) => n.id === this.state.focusedId)
        ? this.state.focusedId
        : (nodes[0]?.id ?? null);
    this.patch({ nodes, focusedId });
  }

  /** Rows currently visible: children of a collapsed node are hidden. */
  get visible(): NodeView[] {
    const out: NodeView[] = [];
    let hiddenBelowDepth: number | null = null;

    for (const node of this.state.nodes) {
      if (hiddenBelowDepth !== null) {
        if (node.depth > hiddenBelowDepth) continue;
        hiddenBelowDepth = null;
      }
      out.push(node);
      if (node.collapsed && node.hasChildren) hiddenBelowDepth = node.depth;
    }
    return out;
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
    const action = resolve(fromEvent(event), this.state.mode);
    if (!action) return false;
    if (action === "newline" || action === "caret-move") return false;

    if (shouldPreventDefault(action)) event.preventDefault();
    void this.dispatch(action);
    return true;
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
        return this.run(() => this.engine.toggleDone(node.id));
      case "promote":
        if (!node) return;
        return this.run(() => this.engine.promote(node.id));
      case "indent":
        if (!node) return;
        return this.run(() => this.engine.indent(node.id));
      case "outdent":
        if (!node) return;
        return this.run(() => this.engine.outdent(node.id));
      case "delete":
        if (!node) return;
        return this.run(() => this.engine.deleteNode(node.id));

      // -- overlays
      case "cheat-sheet":
        return this.patch({ cheatSheetOpen: !this.state.cheatSheetOpen });
      case "command-palette":
        return this.patch({ paletteOpen: !this.state.paletteOpen });
      case "clear":
        return this.patch({ cheatSheetOpen: false, paletteOpen: false, error: null });

      default:
        // Bound in the keymap but not yet wired: tags, collections, search,
        // undo/redo, yank/paste. Deliberately inert rather than silently wrong.
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

  closeOverlays() {
    this.patch({ cheatSheetOpen: false, paletteOpen: false });
  }
}
