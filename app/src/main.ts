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
  onRowClick(id: string, event: MouseEvent): void;
  toggleDone(node: NodeView, event: Event): void;
  paletteResults(): typeof PALETTE_COMMANDS;
  runCommand(id: string): void;
  cheatSheet: typeof CHEAT_SHEET;
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
    },
    visible: [],
    runtime: "…",
    paletteQuery: "",
    cheatSheet: CHEAT_SHEET,

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
      });

      // One listener for the whole app: the controller decides what a key means
      // based on mode, so there is no per-element key wiring to keep in sync.
      window.addEventListener("keydown", (event) => {
        if (this.state.paletteOpen && event.key !== "Escape") return;
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
