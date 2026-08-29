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
import { dataUrl } from "./core/image-widget";
import {
  engine,
  isTauri,
  type Grouping,
  type NodeView,
  type ReportItem,
  type Status,
  type StatusCategory,
} from "./core/engine-port";
import {
  dueDayValue,
  ListController,
  localDayKey,
  type ListState,
  type SidebarEntry,
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

/** How long typing must pause before the `/` filter is applied. */
const QUERY_DEBOUNCE_MS = 120;

/** Where the sidebar's collapsed state is remembered between sessions. */
const SIDEBAR_KEY = "daybook.sidebarCollapsed";


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
  sidebarRows: SidebarEntry[];
  selectSidebarRow(index: number): void;
  isActiveRow(row: SidebarEntry): boolean;
  activeViewName(): string;
  // -- scheduling
  schedule(day: "today" | "tomorrow" | "next-week" | "clear"): void;
  schedulePick(day: string): void;
  detailScheduledValue(): string;
  setDetailScheduled(day: string): void;
  detailRepeatValue(): string;
  setDetailRepeat(rule: string): void;
  /**
   * Lookups the row bindings need, mirrored so they are built once per change
   * rather than once per row. Scanning the node or collection list inside a
   * binding is O(n) per row and therefore O(n²) per render.
   */
  childCounts: Map<string, { done: number; total: number }>;
  collectionsById: Map<string, { name: string; color: string }>;
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
  searchDraft: string;
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
  // -- drag to reorder
  dragging: string | null;
  dropTarget: { id: string; where: "before" | "inside" | "after" } | null;
  onDragStart(node: NodeView, event: DragEvent): void;
  onDragOver(node: NodeView, event: DragEvent): void;
  onDragLeave(node: NodeView): void;
  onDrop(node: NodeView, event: DragEvent): void;
  onDragEnd(): void;
  dropClass(node: NodeView): string;
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
  setStatus(status: Status): void;
  statusColor(hue: string): string;
  /** The status `x` reopens to — it renders quiet, everywhere. */
  defaultOpenStatusId(): string | null;
  // -- statuses editor
  openStatusEditor(): void;
  newStatusDraft: string;
  newStatusCategory: StatusCategory;
  submitNewStatus(): void;
  renameStatusTo(id: string, name: string): void;
  cycleStatusColor(id: string): void;
  removeStatus(id: string): void;
  cycleTagColor(tagId: string, event: Event): void;
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
    applySchedule: (day) => {
      const id = target();
      if (id) void controller.setScheduledDay(id, day);
    },
    applyRepeat: (rule) => {
      const id = target();
      if (id) void controller.applyRepeatRule(id, rule);
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

  /**
   * Attachment storage and lookup, shared by both editors.
   *
   * Not per-editor like `tokenSources`: an attachment belongs to the account,
   * not to the row that happened to receive the paste, so there is nothing to
   * bind to a node here.
   */
  const imageStore = {
    put: (mime: string, bytes: Uint8Array) => port.putBlob(mime, bytes),
    onError: (text: string) => toast(`Could not attach that image: ${text}`, "error"),
    url: async (hash: string) => {
      const blob = await port.blob(hash);
      return blob ? dataUrl(blob.mime, blob.bytes) : null;
    },
  };

  /** Pending debounce for the `/` filter — see `onQuery`. */
  let queryTimer: ReturnType<typeof setTimeout> | null = null;

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
        images: imageStore,
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
        images: imageStore,
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
      allStatuses: [],
      statusEditorOpen: false,
      detailId: null,
      report: null,
      reportDay: "",
      reportGrouping: "collection",
      activeView: "all",
      schedulePopoverOpen: false,
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
    searchDraft: "",
    dragging: null,
    dropTarget: null,
    toastMessage: null,
    theme: "dark",
    density: "dense",
    sidebarRows: [],
    childCounts: new Map(),
    collectionsById: new Map(),
    newCollectionOpen: false,
    newCollectionDraft: "",
    newStatusDraft: "",
    newStatusCategory: "open" as StatusCategory,

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
        this.childCounts = controller.childCounts;
        // Esc clears the filter in the controller; the input has to follow.
        if (!state.query && !state.searchOpen) this.searchDraft = "";
        this.collectionsById = new Map(state.allCollections.map((c) => [c.id, c]));

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

      // Another tab wrote through this one (or this tab was just promoted after
      // the leader closed): re-read rather than showing what was true a moment
      // ago in a different window.
      port.onExternalChange?.(() => void controller.refresh());

      void port.runtime().then((r) => (this.runtime = r));
      void controller
        .refresh()
        // Anything blank at startup was abandoned by a session that never got to
        // clean up after itself — a killed app, a closed tab. Clear it before
        // deciding whether the list is empty, or the litter would suppress the
        // capture row that is supposed to greet you.
        .then(() => controller.discardAbandonedRows())
        .then(() => {
          // Empty list on first run: open a capture line immediately rather than
          // showing a dead screen — insert-by-default, per the discoverability
          // note.
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
      // Only what the checkbox cannot express: the default open status and any
      // done-category status stay quiet, everything else shows its own colour.
      if (node.statusCategory === "done") return null;
      if (node.status === this.defaultOpenStatusId()) return null;
      const status = this.state.allStatuses.find((s) => s.id === node.status);
      if (!status) return null;
      return { color: this.statusColor(status.color), label: status.name };
    },
    childCount(node) {
      // Tolerates null: `x-show` gates *rendering*, not evaluation, so the
      // detail header's binding still runs while no detail view is open.
      if (!node) return "";
      const counts = this.childCounts.get(node.id);
      return counts ? `${counts.done}/${counts.total}` : "0/0";
    },
    collectionName(id) {
      return this.collectionsById.get(id)?.name ?? "Collection";
    },
    collectionColor(hue) {
      // "All" has no hue of its own and collections created before the engine
      // assigned one carry an empty string, so both fall back to the accent.
      return HUES[hue] ?? "var(--primary)";
    },
    collectionDotColor(id) {
      // A row's dot and its sidebar entry must be the same colour, or the dot
      // stops being a way to tell at a glance which collection a todo is in.
      return this.collectionColor(this.collectionsById.get(id)?.color ?? "");
    },

    // -- sidebar -------------------------------------------------------------

    selectCollection(id) {
      controller.setActiveCollection(id);
    },
    selectSidebarRow(index) {
      controller.selectSidebarIndex(index);
    },
    isActiveRow(row) {
      if (row.kind === "collection") return this.state.activeCollectionId === row.id;
      return this.state.activeView === row.view && !this.state.activeCollectionId;
    },
    activeViewName() {
      if (this.state.activeCollectionId) {
        return this.collectionsById.get(this.state.activeCollectionId)?.name ?? "Collection";
      }
      return this.sidebarRows.find((r) => r.kind === "view" && r.view === this.state.activeView)
        ?.name ?? "All";
    },

    // -- scheduling ----------------------------------------------------------

    schedule(day) {
      if (day === "clear") return void controller.scheduleFocused(null);
      const d = new Date();
      if (day === "tomorrow") d.setDate(d.getDate() + 1);
      if (day === "next-week") {
        const days = ((8 - d.getDay()) % 7) || 7;
        d.setDate(d.getDate() + days);
      }
      void controller.scheduleFocused(localDayKey(d));
    },
    schedulePick(day) {
      if (day) void controller.scheduleFocused(day);
    },
    detailScheduledValue() {
      return this.detail?.scheduledFor ?? "";
    },
    setDetailScheduled(day) {
      if (this.detail) void controller.setScheduledDay(this.detail.id, day || null);
    },
    detailRepeatValue() {
      return this.detail?.repeatRule ?? "";
    },
    setDetailRepeat(rule) {
      if (this.detail) void controller.setRepeatRule(this.detail.id, rule.trim() || null);
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
      // The input owns its own text; only the *applied* filter reaches the
      // controller, and only after a pause. Patching per keystroke re-rendered
      // the whole list for a query that was about to change again — measured at
      // ~390ms a character across 2000 rows, nearly all of it thrown away.
      this.searchDraft = value;
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(() => controller.setQuery(value), QUERY_DEBOUNCE_MS);
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

    // -- drag to reorder -----------------------------------------------------

    onDragStart(node, event) {
      this.dragging = node.id;
      // Some text has to be set or Firefox refuses to start the drag at all.
      event.dataTransfer?.setData("text/plain", node.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    },
    onDragOver(node, event) {
      const source = this.dragging;
      // Dropping a node into its own subtree would build a cycle, so those rows
      // stay inert rather than showing an indicator that cannot be honoured.
      if (!source || controller.isAncestorOf(source, node.id)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";

      // Thirds: the outer bands reorder as a sibling, the middle band nests.
      // That is the standard tree gesture, and without the middle band a mouse
      // could reorder but never re-parent.
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const ratio = (event.clientY - box.top) / box.height;
      const where = ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside";
      if (this.dropTarget?.id !== node.id || this.dropTarget?.where !== where) {
        this.dropTarget = { id: node.id, where };
      }
    },
    onDragLeave(node) {
      if (this.dropTarget?.id === node.id) this.dropTarget = null;
    },
    onDrop(node, event) {
      event.preventDefault();
      const source = this.dragging;
      const target = this.dropTarget;
      this.dragging = null;
      this.dropTarget = null;
      if (!source || !target || target.id !== node.id) return;

      if (target.where === "inside") {
        // Onto the front of its children, so a drop lands where the pointer is
        // rather than at the bottom of a list you may not be able to see.
        void controller.moveTo(source, node.id, null);
        return;
      }
      const parent = node.parentId ?? null;
      if (target.where === "after") {
        void controller.moveTo(source, parent, node.id);
        return;
      }
      // "Before this row" is "after the row above it, at the same level".
      const siblings = this.state.nodes.filter((n) => (n.parentId ?? null) === parent);
      const index = siblings.findIndex((n) => n.id === node.id);
      void controller.moveTo(source, parent, index > 0 ? siblings[index - 1]!.id : null);
    },
    onDragEnd() {
      this.dragging = null;
      this.dropTarget = null;
    },
    dropClass(node) {
      if (this.dragging === node.id) return "opacity-40";
      if (this.dropTarget?.id !== node.id) return "";
      if (this.dropTarget.where === "inside") return "drop-inside";
      return this.dropTarget.where === "before" ? "drop-before" : "drop-after";
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
      if (item.statusCategory === "done") return "line-through opacity-55";
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
      // Any non-default status earns its name in prose — that is what the user
      // made it for.
      if (item.statusCategory !== "done" && item.status !== this.defaultOpenStatusId()) {
        return item.statusName.toLowerCase();
      }
      return "";
    },

    // -- detail meta rail ----------------------------------------------------

    setStatus(status) {
      if (this.detail) void controller.setStatus(this.detail.id, status);
    },
    statusColor(hue) {
      return HUES[hue] ?? "var(--muted-foreground)";
    },
    defaultOpenStatusId() {
      return this.state.allStatuses.find((s) => s.category === "open")?.id ?? null;
    },

    // -- statuses editor -----------------------------------------------------

    openStatusEditor() {
      controller.openStatusEditor();
    },
    submitNewStatus() {
      const name = this.newStatusDraft.trim();
      if (!name) return;
      this.newStatusDraft = "";
      void controller.createStatus(name, this.newStatusCategory);
    },
    renameStatusTo(id, name) {
      const trimmed = name.trim();
      const current = this.state.allStatuses.find((s) => s.id === id);
      if (!trimmed || !current || current.name === trimmed) return;
      void controller.renameStatus(id, trimmed);
    },
    cycleStatusColor(id) {
      void controller.cycleStatusColor(id);
    },
    removeStatus(id) {
      void controller.deleteStatus(id);
    },
    cycleTagColor(tagId, event) {
      // Inside the tag overlay the chip's main click removes the tag; the dot
      // is its own smaller target and must not bubble into that.
      event.stopPropagation();
      void controller.cycleTagColor(tagId);
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

/**
 * Register the service worker — browser host, production build only.
 *
 * Not in dev, where it would serve a stale bundle over the top of HMR and make
 * every change look like it did nothing. Not in Tauri, which loads the bundle
 * from disk over its own protocol and has no cold start to rescue.
 */
if (!isTauri() && import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // An unavailable service worker costs offline *cold start* and nothing
      // else — the data is in OPFS either way — so it is not worth an error.
    });
  });
}

Alpine.store("host", { tauri: isTauri() });

declare global {
  interface Window {
    Alpine: typeof Alpine;
  }
}
window.Alpine = Alpine;
Alpine.start();
