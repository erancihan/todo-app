/**
 * Daybook UI boot.
 *
 * Alpine is the **view layer only** (docs/02-architecture.md ADR-001). Mode,
 * focus, the tree, and every keystroke's meaning live in `src/core/` — this file
 * wires that core to the DOM and does nothing else. If Alpine ever strains under
 * the dense list, it can be replaced without touching a line of state logic.
 */

import Alpine from "alpinejs";
import "./app.css";
import { BodyEditor } from "./core/body-editor";
import { engine, isTauri, type NodeView } from "./core/engine-port";
import { ListController, type ListState } from "./core/list-controller";
import { CHEAT_SHEET, PALETTE_COMMANDS } from "./core/commands";

interface AppComponent {
  state: ListState;
  visible: NodeView[];
  runtime: string;
  paletteQuery: string;
  init(): void;
  rows(): NodeView[];
  isFocused(id: string): boolean;
  isEditing(id: string): boolean;
  preview(node: NodeView): string;
  onRowClick(id: string, event: MouseEvent): void;
  toggleDone(node: NodeView, event: Event): void;
  paletteResults(): typeof PALETTE_COMMANDS;
  runCommand(id: string): void;
  cheatSheet: typeof CHEAT_SHEET;
  // -- tags / collections / search
  tagDraft: string;
  collectionDraft: string;
  /**
   * The focused node, mirrored as a reactive property.
   *
   * NOT a method reading the controller: Alpine only re-renders when one of
   * *its* reactive values changes, and a method that reaches into plain
   * controller state has no dependency for Alpine to track. That is why the tag
   * overlay's heading rendered "Untitled" and then never updated.
   */
  focused: NodeView | null;
  submitTag(): void;
  dropTag(tagId: string): void;
  toggleCollection(collectionId: string): void;
  submitCollection(): void;
  inCollection(collectionId: string): boolean;
  onQuery(value: string): void;
  closeOverlays(): void;
}

Alpine.data("daybook", (): AppComponent => {
  const port = engine();
  let editor: BodyEditor | null = null;
  let controller: ListController;

  /** Which row the editor is currently mounted into. */
  let mountedNodeId: string | null = null;

  /** Mount the editor into the focused row's slot, creating it on first use. */
  const mountEditor = (nodeId: string) => {
    // Already here: re-focus but do NOT reload. Reloading resets the document and
    // moves the caret, which silently ate the first character typed after a click
    // landed inside the editor and re-triggered the row's edit handler.
    if (mountedNodeId === nodeId && editor) {
      editor.focus();
      return;
    }

    const slot = document.querySelector<HTMLElement>(`[data-editor-slot="${nodeId}"]`);
    if (!slot) return;

    if (!editor) {
      // One editor instance for the whole app, moved between rows. Its callbacks
      // must therefore never close over a node id — they delegate to the
      // controller, which knows which row currently has focus.
      editor = new BodyEditor(slot, {
        onSubmit: () => void controller.submit(),
        onExit: () => void controller.exitEdit(),
        onChange: (text) => controller.saveFocusedBody(text),
      });
    } else if (editor.element.parentElement !== slot) {
      slot.appendChild(editor.element);
    }

    const node = controller.snapshot.nodes.find((n) => n.id === nodeId);
    editor.load(node?.bodyMd ?? "");
    editor.focus();
    mountedNodeId = nodeId;
  };

  return {
    state: {
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
    },
    visible: [],
    runtime: "…",
    paletteQuery: "",
    cheatSheet: CHEAT_SHEET,
    tagDraft: "",
    collectionDraft: "",
    focused: null,

    init() {
      controller = new ListController(port, {
        openEditor: (nodeId) => {
          // The row must exist in the DOM before the editor can mount into it,
          // and Alpine renders on the next tick.
          queueMicrotask(() => requestAnimationFrame(() => mountEditor(nodeId)));
        },
        closeEditor: () => {
          editor?.flush();
          (document.querySelector("[data-list]") as HTMLElement | null)?.focus();
        },
        editorText: () => editor?.text() ?? "",
      });

      controller.subscribe((state) => {
        this.state = state;
        this.visible = controller.visible;
        this.focused = controller.focusedNode;
      });

      // One listener for the whole app: the controller decides what a key means
      // based on mode, so there is no per-element key wiring to keep in sync.
      window.addEventListener("keydown", (event) => {
        const target = event.target as HTMLElement | null;

        // CodeMirror owns every key inside itself. It already binds Enter,
        // Ctrl/Cmd+Enter, Tab and Escape, so letting this listener also see them
        // dispatches each one TWICE — which made every submit create two rows,
        // one of them blank. Note the editor is a contenteditable div, not an
        // INPUT, so the check below would not have caught it.
        if (target?.closest(".cm-editor")) return;

        // Overlay inputs: LIST verbs must not fire while typing a tag name —
        // the `t` in "later" is a letter, not "open the tag editor". Escape
        // still gets through so there is always a way out.
        const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
        if (typing && event.key !== "Escape") return;

        controller.handleKey(event);
      });

      void port.runtime().then((r) => (this.runtime = r));
      void controller.refresh().then(() => {
        // Empty list on first run: open a capture line immediately rather than
        // showing a dead screen — insert-by-default, per the discoverability note.
        if (this.state.nodes.length === 0) void controller.dispatch("quick-add");
      });
    },

    rows() {
      return this.visible;
    },
    isFocused(id) {
      return this.state.focusedId === id;
    },
    isEditing(id) {
      return this.state.mode === "edit" && this.state.focusedId === id;
    },
    preview(node) {
      // Everything after the line the title was derived from, flattened to one
      // line. Showing the title line again would just duplicate the row heading.
      const lines = node.bodyMd.split("\n");
      const titleLine = lines.findIndex((l) => l.trim() !== "");
      if (titleLine === -1) return "";
      return lines
        .slice(titleLine + 1)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    },
    onRowClick(id, event) {
      // A click landing inside the editor is the user placing their caret, not a
      // request to (re)open the row. Let CodeMirror have it — re-entering would
      // reload the document and move the caret out from under them.
      if ((event.target as HTMLElement | null)?.closest(".cm-editor")) return;
      controller.focus(id);
      controller.enterEdit(id);
    },
    toggleDone(node, event) {
      // The checkbox is a mouse affordance for `x`; don't also open the editor.
      event.stopPropagation();
      controller.focus(node.id);
      void controller.dispatch("toggle-done");
    },
    paletteResults() {
      const q = this.paletteQuery.trim().toLowerCase();
      if (!q) return PALETTE_COMMANDS;
      return PALETTE_COMMANDS.filter(
        (c) => c.label.toLowerCase().includes(q) || c.keys.join(" ").toLowerCase().includes(q),
      );
    },
    runCommand(id) {
      this.paletteQuery = "";
      controller.closeOverlays();
      void controller.dispatch(id as Parameters<ListController["dispatch"]>[0]);
    },

    // -- tags / collections / search ---------------------------------------

    submitTag() {
      const name = this.tagDraft.trim();
      const node = controller.focusedNode;
      if (!name || !node) return;
      this.tagDraft = "";
      void controller.addTag(node.id, name);
    },
    dropTag(tagId) {
      const node = controller.focusedNode;
      if (node) void controller.removeTag(node.id, tagId);
    },
    toggleCollection(collectionId) {
      const node = controller.focusedNode;
      if (node) void controller.toggleCollection(node.id, collectionId);
    },
    submitCollection() {
      const name = this.collectionDraft.trim();
      if (!name) return;
      this.collectionDraft = "";
      void controller.createCollection(name, controller.focusedNode?.id);
    },
    inCollection(collectionId) {
      // Reads the reactive mirror, not the controller, so the checkboxes update
      // when membership changes rather than only when the collection list does.
      return this.focused?.collectionIds.includes(collectionId) ?? false;
    },
    onQuery(value) {
      controller.setQuery(value);
    },
    closeOverlays() {
      controller.closeOverlays();
    },
  };
});

Alpine.store("host", { tauri: isTauri() });

declare global {
  interface Window {
    Alpine: typeof Alpine;
  }
}
window.Alpine = Alpine;
Alpine.start();
