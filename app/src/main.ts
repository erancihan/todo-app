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
import type { TokenSources } from "./core/token-complete";
import {
  engine,
  isTauri,
  type Grouping,
  type NodeView,
  type ReportItem,
  type Status,
} from "./core/engine-port";
import {
  dueDayValue,
  ListController,
  localDayKey,
  type ListState,
} from "./core/list-controller";
import { CHEAT_SHEET, PALETTE_COMMANDS } from "./core/commands";
import { dismissToast, subscribeToasts, toast, type ToastMessage } from "./core/toast";
import {
  initAppearance,
  setDensity,
  setTheme,
  type Density,
  type Theme,
} from "./core/appearance";

type SidebarRow = ListController["sidebarRows"][number];

/**
 * The eight muted hue names the engine assigns, mapped to the same values
 * `app.css` gives the tag pills. Kept in one place so a collection dot and a tag
 * chip of the same hue are actually the same colour.
 */
const HUES: Record<string, string> = {
  slate: "#64748b",
  rose: "#e5678a",
  amber: "#e0a03a",
  pink: "#db7bc0",
  emerald: "#3fb984",
  cyan: "#3fa9c9",
  violet: "#9b7be0",
  lime: "#8dbf3f",
};

/** The pivots the report view offers (docs/03 §8.3). */
const GROUPINGS: Array<{ value: Grouping; label: string }> = [
  { value: "collection", label: "Collection" },
  { value: "tag", label: "Tag" },
  { value: "flat", label: "Flat" },
];

/** The three theme choices. `system` is a real option, not a fallback. */
const THEMES: Array<{ value: Theme; label: string; icon: string }> = [
  { value: "light", label: "Light", icon: "☀" },
  { value: "dark", label: "Dark", icon: "☾" },
  { value: "system", label: "System", icon: "◐" },
];

/** Where the sidebar's collapsed state is remembered between sessions. */
const SIDEBAR_KEY = "daybook.sidebarCollapsed";

/**
 * The statuses the detail rail offers.
 *
 * `inbox` is deliberately absent: it is the state a node is born in and means
 * "not yet triaged", so offering it as a destination would let you un-triage
 * something, which is not a thing anyone wants to say.
 */
const STATUSES: Array<{ value: Status; label: string; color: string }> = [
  { value: "todo", label: "Todo", color: "var(--muted-foreground)" },
  { value: "in_progress", label: "In progress", color: "var(--warning)" },
  { value: "blocked", label: "Blocked", color: "var(--destructive)" },
  { value: "done", label: "Done", color: "var(--success)" },
  { value: "dropped", label: "Dropped", color: "var(--muted-foreground)" },
];

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
  toggleDone(node: NodeView | null, event: Event): void;
  toggleCollapse(node: NodeView, event: Event): void;
  statusDot(node: NodeView): { color: string; label: string } | null;
  childCount(node: NodeView | null): string;
  collectionName(id: string): string;
  collectionColor(hue: string): string;
  collectionDotColor(id: string): string;
  // -- sidebar
  /** Mirrored reactively for the same reason as `focused` — see below. */
  sidebarRows: SidebarRow[];
  selectCollection(id: string | null): void;
  toggleSidebar(): void;
  newCollection(): void;
  newCollectionOpen: boolean;
  newCollectionDraft: string;
  submitNewCollection(): void;
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
  // -- detail view (Screen 3)
  /** Mirrored reactively, like `focused`. */
  detail: NodeView | null;
  detailParent: NodeView | null;
  openDetail(id?: string): void;
  closeDetail(): void;
  rowIndent(node: NodeView): number;
  stamp(ms: number | null | undefined): string;
  promoteFromDetail(node: NodeView, event: Event): void;
  // -- EOD report (Screen 4)
  openReport(): void;
  closeReport(): void;
  shiftReportDay(days: number): void;
  setReportGrouping(grouping: Grouping): void;
  copyReport(): void;
  reportIsToday(): boolean;
  reportItemClasses(item: ReportItem): string;
  reportAnnotation(item: ReportItem): string;
  GROUPINGS: typeof GROUPINGS;
  tagColor(name: string): string;
  clockTime(ms: number | null): string;
  // -- toast
  toastMessage: ToastMessage | null;
  dismissToast(): void;
  // The meta rail edits the *detail* node; `t` and `c` still act on the focused
  // sub-item, so these cannot share the overlay handlers.
  STATUSES: typeof STATUSES;
  setStatus(status: Status): void;
  detailInCollection(collectionId: string): boolean;
  toggleDetailCollection(collectionId: string): void;
  detailTagDraft: string;
  submitDetailTag(): void;
  dropDetailTag(tagId: string): void;
  // -- appearance
  theme: Theme;
  density: Density;
  chooseTheme(theme: Theme): void;
  toggleDensity(): void;
  THEMES: typeof THEMES;
  detailDueValue(): string;
  setDetailDue(day: string): void;
}

Alpine.data("daybook", (): AppComponent => {
  const port = engine();
  let editor: BodyEditor | null = null;
  let controller: ListController;

  /**
   * `#tag` / `@collection` completion, bound to whichever node an editor edits.
   *
   * `target` is a getter, not a value: the roving editor moves between rows, so
   * a captured id would file every tag onto the first row ever edited — the same
   * trap the autosave callbacks avoid.
   */
  const tokenSources = (target: () => string | null): TokenSources => ({
    tags: () => controller.snapshot.allTags.map((t) => t.name),
    collections: () => controller.snapshot.allCollections.map((c) => c.name),
    applyTag: (name) => {
      const id = target();
      if (id) void controller.addTag(id, name);
    },
    applyCollection: (name) => {
      const id = target();
      if (!id) return;
      const existing = controller.snapshot.allCollections.find(
        (c) => c.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing) void controller.toggleCollection(id, existing.id);
      else void controller.createCollection(name, id);
    },
  });

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
        tokens: tokenSources(() => controller.snapshot.focusedId),
      });
    } else if (editor.element.parentElement !== slot) {
      slot.appendChild(editor.element);
    }

    const node = controller.snapshot.nodes.find((n) => n.id === nodeId);
    editor.load(node?.bodyMd ?? "");
    editor.focus();
    mountedNodeId = nodeId;
  };

  /**
   * The DetailedTodoView's own body editor.
   *
   * A second instance, not the roving one: in the detail view focus is on a
   * sub-item, so a shared editor would have to be dragged between the reading
   * column and the checklist on every keystroke, and the main body — which is
   * meant to be permanently live — would blink out each time.
   */
  let detailEditor: BodyEditor | null = null;
  let detailMountedId: string | null = null;

  const mountDetailEditor = (nodeId: string) => {
    const slot = document.querySelector<HTMLElement>("[data-detail-body]");
    if (!slot) return;

    if (!detailEditor) {
      detailEditor = new BodyEditor(slot, {
        // Ctrl/Cmd+Enter here means "done writing", not "open another todo":
        // there is no streak on this surface.
        onSubmit: () => detailEditor?.flush(),
        onExit: () => {
          detailEditor?.flush();
          (document.querySelector("[data-list]") as HTMLElement | null)?.focus();
        },
        onChange: (text) => controller.saveDetailBody(text),
        tokens: tokenSources(() => controller.snapshot.detailId),
      });
    } else if (detailEditor.element.parentElement !== slot) {
      slot.appendChild(detailEditor.element);
    }

    if (detailMountedId !== nodeId) {
      const node = controller.snapshot.nodes.find((n) => n.id === nodeId);
      detailEditor.load(node?.bodyMd ?? "");
      detailMountedId = nodeId;
    }
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
    },
    visible: [],
    runtime: "…",
    paletteQuery: "",
    cheatSheet: CHEAT_SHEET,
    tagDraft: "",
    collectionDraft: "",
    focused: null,
    detail: null,
    detailParent: null,
    detailTagDraft: "",
    toastMessage: null,
    theme: "dark",
    density: "dense",
    sidebarRows: [],
    newCollectionOpen: false,
    newCollectionDraft: "",

    init() {
      controller = new ListController(port, {
        openEditor: (nodeId) => {
          // The row must exist in the DOM before the editor can mount into it,
          // and Alpine renders on the next tick.
          queueMicrotask(() => requestAnimationFrame(() => mountEditor(nodeId)));
        },
        closeEditor: () => {
          // Only a *mounted* editor holds text worth saving. Flushing an
          // unmounted one writes its stale document — typically the blank row it
          // was last loaded with — straight over whatever row happens to be
          // focused now, silently emptying a todo that was never opened. That is
          // real data loss, and it fires on any path that closes the editor
          // while the list has moved on.
          if (mountedNodeId) {
            editor?.flush();
            mountedNodeId = null;
          }
          (document.querySelector("[data-list]") as HTMLElement | null)?.focus();
        },
        editorText: () => editor?.text() ?? "",
        openDetail: (nodeId) => {
          // The reading column has to exist before the editor can move into it,
          // and Alpine renders on the next tick.
          queueMicrotask(() => requestAnimationFrame(() => mountDetailEditor(nodeId)));
        },
        closeDetail: () => {
          // Same rule as `closeEditor`: an unmounted editor's text is stale.
          if (detailMountedId) detailEditor?.flush();
          // Forget the mount so re-opening reloads from the engine: the body may
          // have been edited inline in the list while this view was closed.
          detailMountedId = null;
        },
      });

      // The sidebar starts where it was left. A collapsed rail that silently
      // re-expands every launch is the kind of small betrayal that makes a
      // preference feel broken.
      try {
        controller.setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
      } catch {
        // Private windows and blocked site data throw on access, not on read.
      }

      const appearance = initAppearance();
      this.theme = appearance.theme;
      this.density = appearance.density;

      subscribeToasts((message) => (this.toastMessage = message));

      let lastCollapsed = controller.snapshot.sidebarCollapsed;
      controller.subscribe((state) => {
        this.state = state;
        this.visible = controller.visible;
        this.focused = controller.focusedNode;
        this.detail = controller.detailNode;
        this.detailParent = controller.detailParent;
        this.sidebarRows = controller.sidebarRows;

        if (state.sidebarCollapsed !== lastCollapsed) {
          lastCollapsed = state.sidebarCollapsed;
          try {
            localStorage.setItem(SIDEBAR_KEY, state.sidebarCollapsed ? "1" : "0");
          } catch {
            // Not being able to remember it is not a reason to fail the toggle.
          }
        }
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
      if (!node) return;
      controller.focus(node.id);
      void controller.dispatch("toggle-done");
    },
    toggleCollapse(node, event) {
      event.stopPropagation();
      if (!node.hasChildren) return;
      controller.focus(node.id);
      void controller.dispatch(node.collapsed ? "expand-or-child" : "collapse-or-parent");
    },
    statusDot(node) {
      // Only the states the checkbox cannot express. `inbox` is the default a
      // node is born in and means nothing yet, so it stays quiet too.
      switch (node.status) {
        case "in_progress":
          return { color: "var(--warning)", label: "In progress" };
        case "blocked":
          return { color: "var(--destructive)", label: "Blocked" };
        case "dropped":
          return { color: "var(--muted-foreground)", label: "Dropped" };
        default:
          return null;
      }
    },
    childCount(node) {
      // Tolerates null: `x-show` gates *rendering*, not evaluation, so the
      // detail header's binding still runs while no detail view is open.
      if (!node) return "";
      const children = this.state.nodes.filter((n) => n.parentId === node.id);
      const done = children.filter((n) => n.status === "done").length;
      return `${done}/${children.length}`;
    },
    collectionName(id) {
      return this.state.allCollections.find((c) => c.id === id)?.name ?? "Collection";
    },
    collectionColor(hue) {
      // "All" has no hue of its own and collections created before the engine
      // assigned one carry an empty string, so both fall back to the accent.
      return HUES[hue] ?? "var(--primary)";
    },
    collectionDotColor(id) {
      // A row's dot and its sidebar entry must be the same colour, or the dot
      // stops being a way to tell at a glance which collection a todo is in.
      return this.collectionColor(
        this.state.allCollections.find((c) => c.id === id)?.color ?? "",
      );
    },

    // -- sidebar -------------------------------------------------------------

    selectCollection(id) {
      controller.setActiveCollection(id);
    },
    toggleSidebar() {
      controller.setSidebarCollapsed(!this.state.sidebarCollapsed);
    },
    newCollection() {
      // An inline field, not `window.prompt`: a native modal steals focus from
      // the whole page and would be the one place in the app the keyboard model
      // stops applying.
      this.newCollectionOpen = true;
    },
    submitNewCollection() {
      const name = this.newCollectionDraft.trim();
      this.newCollectionDraft = "";
      this.newCollectionOpen = false;
      // No node id: filing the focused todo into a collection is what `c` does.
      // Doing it here too would make "add a collection" quietly edit a todo.
      if (name) void controller.createCollection(name);
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
    dismissToast,
    THEMES,
    chooseTheme(theme) {
      this.theme = theme;
      setTheme(theme);
    },
    toggleDensity() {
      this.density = this.density === "dense" ? "comfortable" : "dense";
      setDensity(this.density);
    },

    // -- detail view ---------------------------------------------------------

    openDetail(id) {
      controller.openDetail(id);
    },
    closeDetail() {
      controller.closeDetail();
    },
    rowIndent(node) {
      // The engine's depth is absolute. In the detail view the checklist indents
      // relative to the todo being viewed, so its direct children sit flush left
      // instead of starting three levels in.
      if (!this.detail) return node.depth;
      return Math.max(0, node.depth - this.detail.depth - 1);
    },
    stamp(ms) {
      if (!ms) return "";
      return new Date(ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    },
    promoteFromDetail(node, event) {
      event.stopPropagation();
      controller.focus(node.id);
      void controller.dispatch("promote");
    },

    // -- EOD report ----------------------------------------------------------

    GROUPINGS,
    openReport() {
      void controller.openReport();
    },
    closeReport() {
      controller.closeReport();
    },
    shiftReportDay(days) {
      void controller.shiftReportDay(days);
    },
    setReportGrouping(grouping) {
      void controller.openReport(this.state.reportDay, grouping);
    },
    copyReport() {
      const markdown = this.state.report?.markdown;
      if (!markdown) return;
      // Markdown is the universal paste target (docs/03 §8.6), so the clipboard
      // gets the source text, not the rendered HTML.
      void navigator.clipboard
        .writeText(markdown)
        .then(() => toast("Report copied as markdown"))
        .catch(() => toast("Could not reach the clipboard", "error"));
    },
    tagColor(name) {
      // The report carries tag *names*, not ids — it is a log-derived document,
      // not a view of the tree. Look the hue up so a chip in the report matches
      // the same chip in the list.
      return this.state.allTags.find((t) => t.name === name)?.color ?? "slate";
    },
    clockTime(ms) {
      if (!ms) return "";
      return new Date(ms).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
    },
    reportIsToday() {
      return this.state.reportDay === localDayKey(new Date());
    },
    reportItemClasses(item) {
      if (item.status === "done") return "line-through opacity-55";
      if (item.bucket === "carried_over") return "text-muted-foreground";
      return "";
    },
    reportAnnotation(item) {
      if (item.bucket === "carried_over") {
        return item.slippedDays > 0
          ? `carried over · slipped ${item.slippedDays} day${item.slippedDays === 1 ? "" : "s"}`
          : "carried over";
      }
      if (item.promotedInRange) return "promoted today ↑";
      if (item.status === "in_progress") return "in progress";
      if (item.status === "blocked") return "blocked";
      return "";
    },

    // -- detail meta rail ----------------------------------------------------

    STATUSES,
    setStatus(status) {
      if (this.detail) void controller.setStatus(this.detail.id, status);
    },
    detailInCollection(collectionId) {
      return this.detail?.collectionIds.includes(collectionId) ?? false;
    },
    toggleDetailCollection(collectionId) {
      if (this.detail) void controller.toggleCollection(this.detail.id, collectionId);
    },
    submitDetailTag() {
      const name = this.detailTagDraft.trim();
      if (!name || !this.detail) return;
      this.detailTagDraft = "";
      void controller.addTag(this.detail.id, name);
    },
    dropDetailTag(tagId) {
      if (this.detail) void controller.removeTag(this.detail.id, tagId);
    },
    detailDueValue() {
      return dueDayValue(this.detail?.dueAt ?? null);
    },
    setDetailDue(day) {
      if (this.detail) void controller.setDue(this.detail.id, day || null);
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
