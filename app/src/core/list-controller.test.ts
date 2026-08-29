import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dueDayValue,
  endOfLocalDay,
  ListController,
  localDayKey,
  matchesView,
  nextMondayKey,
} from "./list-controller";
import type { EnginePort, NodeView } from "./engine-port";

/**
 * A fake engine holding a flat tree, so the controller's own logic — visibility,
 * focus movement, mode — is tested without SQLite or wasm in the way. The engine
 * itself is tested in Rust; what is under test here is the glue.
 */
function node(partial: Partial<NodeView> & { id: string }): NodeView {
  const status = partial.status ?? "todo";
  return {
    parentId: null,
    kind: "task",
    promoted: false,
    title: partial.id,
    bodyMd: "",
    status,
    // Derived from the built-in ids the way the engine resolves them, so tests
    // written against the old enum keep meaning what they meant.
    statusCategory: status === "done" ? "done" : status === "dropped" ? "cancelled" : "open",
    orderKey: partial.id,
    createdAt: 0,
    updatedAt: 0,
    dueAt: null,
    scheduledFor: null,
    repeatRule: null,
    completedAt: null,
    collapsed: false,
    depth: 0,
    hasChildren: false,
    tags: [],
    collectionIds: [],
    ...partial,
  };
}

function fakeEngine(tree: NodeView[]): EnginePort {
  const stub = () => Promise.resolve(undefined as never);
  return {
    runtime: () => Promise.resolve("test"),
    listTree: () => Promise.resolve(tree),
    node: (id: string) => Promise.resolve(tree.find((n) => n.id === id) ?? null),
    createNode: vi.fn(() => Promise.resolve(node({ id: "new" }))),
    setTitle: vi.fn(stub),
    setBody: vi.fn(stub),
    setStatus: vi.fn(() => Promise.resolve(null)),
    setDue: vi.fn(stub),
    setScheduled: vi.fn(stub),
    setRepeat: vi.fn(stub),
    toggleDone: vi.fn(() => Promise.resolve(null)),
    promote: vi.fn(stub),
    demote: vi.fn(stub),
    restoreNode: vi.fn(() => Promise.resolve(1)),
    duplicateNode: vi.fn(() => Promise.resolve(node({ id: "copy" }))),
    indent: vi.fn(stub),
    outdent: vi.fn(stub),
    moveNode: vi.fn(stub),
    deleteNode: vi.fn(() => Promise.resolve(1)),
    setCollapsed: vi.fn(stub),
    addTag: vi.fn(() => Promise.resolve({ id: "t", name: "t", color: "slate" })),
    removeTag: vi.fn(stub),
    listTags: () => Promise.resolve([]),
    createCollection: vi.fn(),
    listCollections: () => Promise.resolve([]),
    listStatuses: () =>
      Promise.resolve([
        { id: "todo", name: "Todo", category: "open", color: "", sort: 0, builtIn: true },
        { id: "done", name: "Done", category: "done", color: "emerald", sort: 4, builtIn: true },
      ]),
    createStatus: vi.fn(),
    renameStatus: vi.fn(stub),
    setStatusColor: vi.fn(stub),
    deleteStatus: vi.fn(stub),
    setTagColor: vi.fn(stub),
    addToCollection: vi.fn(stub),
    removeFromCollection: vi.fn(stub),
    eventsBetween: () => Promise.resolve([]),
    generateReport: vi.fn(() =>
      Promise.resolve({
        title: "EOD — 2026-08-23",
        markdown: "# EOD — 2026-08-23\n",
        sections: [],
        counts: { created: 0, updated: 0, completed: 0, carriedOver: 0 },
        carriedOverIds: [],
        duplicated: false,
      }),
    ),
    commitCarryOver: vi.fn(() => Promise.resolve(0)),
    putBlob: vi.fn(() => Promise.resolve("hash")),
    blob: vi.fn(() => Promise.resolve(null)),
    listBlobs: vi.fn(() => Promise.resolve([])),
    eventsForNode: () => Promise.resolve([]),
  } as unknown as EnginePort;
}

const host = {
  openEditor: vi.fn(),
  closeEditor: vi.fn(),
  editorText: () => "",
  openDetail: vi.fn(),
  closeDetail: vi.fn(),
};

/** root, with two children, then a second root. */
const TREE = [
  node({ id: "root", hasChildren: true, depth: 0 }),
  node({ id: "child-a", parentId: "root", depth: 1 }),
  node({ id: "child-b", parentId: "root", depth: 1 }),
  node({ id: "second", depth: 0 }),
];

describe("visibility", () => {
  it("shows the whole tree when nothing is collapsed", async () => {
    const c = new ListController(fakeEngine(TREE), host);
    await c.refresh();
    expect(c.visible.map((n) => n.id)).toEqual(["root", "child-a", "child-b", "second"]);
  });

  it("hides children of a collapsed node but keeps its siblings", async () => {
    const collapsed = TREE.map((n) => (n.id === "root" ? { ...n, collapsed: true } : n));
    const c = new ListController(fakeEngine(collapsed), host);
    await c.refresh();
    expect(c.visible.map((n) => n.id)).toEqual(["root", "second"]);
  });

  it("does not hide anything for a collapsed leaf", async () => {
    // `collapsed` on a childless node is meaningless; treating it as a fence
    // would swallow every following row at the same depth.
    const collapsed = TREE.map((n) => (n.id === "child-a" ? { ...n, collapsed: true } : n));
    const c = new ListController(fakeEngine(collapsed), host);
    await c.refresh();
    expect(c.visible.map((n) => n.id)).toEqual(["root", "child-a", "child-b", "second"]);
  });
});

describe("focus", () => {
  let controller: ListController;

  beforeEach(async () => {
    controller = new ListController(fakeEngine(TREE), host);
    await controller.refresh();
  });

  it("starts on the first row", () => {
    expect(controller.snapshot.focusedId).toBe("root");
  });

  it("j and k move through visible rows", async () => {
    await controller.dispatch("focus-next");
    expect(controller.snapshot.focusedId).toBe("child-a");
    await controller.dispatch("focus-next");
    expect(controller.snapshot.focusedId).toBe("child-b");
    await controller.dispatch("focus-prev");
    expect(controller.snapshot.focusedId).toBe("child-a");
  });

  it("clamps at both ends rather than wrapping", async () => {
    await controller.dispatch("focus-prev");
    expect(controller.snapshot.focusedId).toBe("root");
    for (let i = 0; i < 10; i++) await controller.dispatch("focus-next");
    expect(controller.snapshot.focusedId).toBe("second");
  });

  it("jumps to the first and last row", async () => {
    await controller.dispatch("jump-last");
    expect(controller.snapshot.focusedId).toBe("second");
    await controller.dispatch("jump-first");
    expect(controller.snapshot.focusedId).toBe("root");
  });

  it("skips hidden rows when navigating", async () => {
    const collapsed = TREE.map((n) => (n.id === "root" ? { ...n, collapsed: true } : n));
    const c = new ListController(fakeEngine(collapsed), host);
    await c.refresh();
    await c.dispatch("focus-next");
    expect(c.snapshot.focusedId).toBe("second");
  });
});

describe("mode", () => {
  it("e enters EDIT and Esc returns to LIST", async () => {
    const c = new ListController(fakeEngine(TREE), host);
    await c.refresh();

    await c.dispatch("edit");
    expect(c.snapshot.mode).toBe("edit");
    expect(host.openEditor).toHaveBeenCalledWith("root");

    await c.exitEdit();
    expect(c.snapshot.mode).toBe("list");
  });
});

describe("key handling", () => {
  let controller: ListController;

  beforeEach(async () => {
    controller = new ListController(fakeEngine(TREE), host);
    await controller.refresh();
  });

  /**
   * A minimal key event. The controller reads five fields and may call
   * `preventDefault`, so a stub covers it without pulling a DOM environment in
   * for five assertions.
   */
  function press(
    key: string,
    init: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
  ) {
    let defaultPrevented = false;
    const event = {
      key,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...init,
      preventDefault: () => {
        defaultPrevented = true;
      },
    } as unknown as KeyboardEvent;

    const consumed = controller.handleKey(event);
    return { consumed, defaultPrevented };
  }

  it("consumes bound LIST keys and prevents their default", () => {
    const { consumed, defaultPrevented } = press("j");
    expect(consumed).toBe(true);
    expect(defaultPrevented).toBe(true);
  });

  it("ignores unbound keys so typing reaches the editor", () => {
    expect(press("q").consumed).toBe(false);
  });

  it("never consumes a newline in EDIT mode", async () => {
    // The whole notepad promise, and on mobile the difference between a working
    // and a broken soft keyboard: Enter must reach CodeMirror untouched.
    await controller.dispatch("edit");
    const { consumed, defaultPrevented } = press("Enter");
    expect(consumed).toBe(false);
    expect(defaultPrevented).toBe(false);
  });

  it("never consumes arrow keys in EDIT mode", async () => {
    await controller.dispatch("edit");
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(press(key).consumed).toBe(false);
    }
    // ...and row focus did not move.
    expect(controller.snapshot.focusedId).toBe("root");
  });

  it("consumes Ctrl+Enter in EDIT mode", async () => {
    await controller.dispatch("edit");
    expect(press("Enter", { ctrlKey: true }).consumed).toBe(true);
  });
});

describe("two-key sequences", () => {
  let controller: ListController;

  beforeEach(async () => {
    controller = new ListController(fakeEngine(TREE), host);
    await controller.refresh();
  });

  function press(key: string) {
    const event = {
      key,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault: () => {},
    } as unknown as KeyboardEvent;
    return controller.handleKey(event);
  }

  it("buffers the first key and shows it", () => {
    expect(press("d")).toBe(true);
    expect(controller.snapshot.pendingKey).toBe("d");
  });

  it("dd deletes and clears the buffer", async () => {
    press("d");
    press("d");
    await vi.waitFor(() => expect(controller.snapshot.pendingKey).toBeNull());
  });

  it("gg jumps to the first row", async () => {
    await controller.dispatch("jump-last");
    expect(controller.snapshot.focusedId).toBe("second");
    press("g");
    press("g");
    await vi.waitFor(() => expect(controller.snapshot.focusedId).toBe("root"));
  });

  it("an aborted sequence still runs the second key on its own", async () => {
    // `d` then `j` must move down, not swallow the j.
    expect(controller.snapshot.focusedId).toBe("root");
    press("d");
    press("j");
    await vi.waitFor(() => expect(controller.snapshot.focusedId).toBe("child-a"));
    expect(controller.snapshot.pendingKey).toBeNull();
  });

  it("does not start a sequence in EDIT mode", async () => {
    await controller.dispatch("edit");
    expect(press("d")).toBe(false);
    expect(controller.snapshot.pendingKey).toBeNull();
  });
});

describe("search", () => {
  let controller: ListController;

  beforeEach(async () => {
    controller = new ListController(fakeEngine(TREE), host);
    await controller.refresh();
  });

  it("shows everything when the query is empty", () => {
    expect(controller.visible).toHaveLength(4);
  });

  it("filters to matching rows", () => {
    controller.setQuery("second");
    expect(controller.visible.map((n) => n.id)).toEqual(["second"]);
  });

  it("keeps ancestors of a match so the tree stays coherent", () => {
    // `child-b` matches; `root` does not, but dropping it would leave a child
    // rendered at depth 1 with no visible parent.
    controller.setQuery("child-b");
    expect(controller.visible.map((n) => n.id)).toEqual(["root", "child-b"]);
  });

  it("matches on tag name too", () => {
    const tagged = TREE.map((n) =>
      n.id === "second" ? { ...n, tags: [{ id: "t1", name: "urgent", color: "rose" }] } : n,
    );
    const c = new ListController(fakeEngine(tagged), host);
    return c.refresh().then(() => {
      c.setQuery("urgent");
      expect(c.visible.map((n) => n.id)).toEqual(["second"]);
    });
  });
});

describe("overlays", () => {
  it("? toggles the cheat sheet and Esc clears it", async () => {
    const c = new ListController(fakeEngine(TREE), host);
    await c.refresh();

    await c.dispatch("cheat-sheet");
    expect(c.snapshot.cheatSheetOpen).toBe(true);
    await c.dispatch("clear");
    expect(c.snapshot.cheatSheetOpen).toBe(false);
  });
});

describe("abandoned empty rows", () => {
  /** A tree with one real row and one blank capture row left behind. */
  const WITH_BLANK = [
    node({ id: "real", title: "Real todo", bodyMd: "Real todo\nbody" }),
    node({ id: "blank", title: "", bodyMd: "" }),
  ];

  it("deletes a blank row on leaving it", async () => {
    const engine = fakeEngine(WITH_BLANK);
    const c = new ListController(engine, host);
    await c.refresh();
    c.focus("blank");

    await c.exitEdit();
    expect(engine.deleteNode).toHaveBeenCalledWith("blank");
  });

  it("keeps a row that has content", async () => {
    const engine = fakeEngine(WITH_BLANK);
    const c = new ListController(engine, host);
    await c.refresh();
    c.focus("real");

    await c.exitEdit();
    expect(engine.deleteNode).not.toHaveBeenCalled();
  });

  it("keeps a blank row that carries tags", async () => {
    // No text, but the user put a tag on it — that is intent, not litter.
    const tagged = [
      node({ id: "blank", tags: [{ id: "t", name: "later", color: "slate" }], title: "" }),
    ];
    const engine = fakeEngine(tagged);
    const c = new ListController(engine, host);
    await c.refresh();
    c.focus("blank");

    await c.exitEdit();
    expect(engine.deleteNode).not.toHaveBeenCalled();
  });

  it("keeps a blank parent that has children", async () => {
    const parent = [
      node({ id: "blank", title: "", hasChildren: true }),
      node({ id: "kid", parentId: "blank", depth: 1, title: "child" }),
    ];
    const engine = fakeEngine(parent);
    const c = new ListController(engine, host);
    await c.refresh();
    c.focus("blank");

    await c.exitEdit();
    expect(engine.deleteNode).not.toHaveBeenCalled();
  });

  it("submitting an empty row ends the streak instead of opening another", async () => {
    const engine = fakeEngine(WITH_BLANK);
    const c = new ListController(engine, host);
    await c.refresh();
    c.focus("blank");

    await c.submit();
    expect(engine.createNode).not.toHaveBeenCalled();
    expect(engine.deleteNode).toHaveBeenCalledWith("blank");
  });

  it("submitting a row with content does open the next one", async () => {
    const engine = fakeEngine(WITH_BLANK);
    const c = new ListController(engine, host);
    await c.refresh();
    c.focus("real");

    await c.submit();
    expect(engine.createNode).toHaveBeenCalled();
  });
});

describe("undo / redo", () => {
  let engine: EnginePort;
  let controller: ListController;

  beforeEach(async () => {
    engine = fakeEngine(TREE);
    controller = new ListController(engine, host);
    await controller.refresh();
  });

  const spy = (name: keyof EnginePort) => engine[name] as ReturnType<typeof vi.fn>;

  it("does nothing when there is no history", async () => {
    await controller.dispatch("undo");
    expect(controller.snapshot.canUndo).toBe(false);
    expect(spy("toggleDone")).not.toHaveBeenCalled();
  });

  it("undoes a toggle by toggling back", async () => {
    await controller.dispatch("toggle-done");
    expect(controller.snapshot.canUndo).toBe(true);

    await controller.dispatch("undo");
    expect(spy("toggleDone")).toHaveBeenCalledTimes(2);
    expect(controller.snapshot.canRedo).toBe(true);
  });

  it("undoes a promote by demoting", async () => {
    await controller.dispatch("promote");
    await controller.dispatch("undo");
    expect(spy("demote")).toHaveBeenCalledWith("root");
  });

  it("undoes a delete by restoring", async () => {
    await controller.dispatch("delete");
    await controller.dispatch("undo");
    expect(spy("restoreNode")).toHaveBeenCalledWith("root");
  });

  it("undoes an indent by moving the node back where it was", async () => {
    // `child-b` sits after `child-a` under `root`; undo must restore both the
    // parent and the position, which plain outdent would not do.
    controller.focus("child-b");
    await controller.dispatch("indent");
    await controller.dispatch("undo");
    expect(spy("moveNode")).toHaveBeenCalledWith("child-b", "root", "child-a");
  });

  it("redo replays the original action", async () => {
    await controller.dispatch("promote");
    await controller.dispatch("undo");
    await controller.dispatch("redo");
    expect(spy("promote")).toHaveBeenCalledTimes(2);
    expect(controller.snapshot.canUndo).toBe(true);
  });

  it("a new action clears the redo branch", async () => {
    await controller.dispatch("toggle-done");
    await controller.dispatch("undo");
    expect(controller.snapshot.canRedo).toBe(true);

    await controller.dispatch("promote");
    expect(controller.snapshot.canRedo).toBe(false);
  });

  it("promoting an already-promoted node records nothing", async () => {
    // Otherwise undo would "demote" a node the action never promoted.
    const promoted = TREE.map((n) => (n.id === "root" ? { ...n, promoted: true } : n));
    const e = fakeEngine(promoted);
    const c = new ListController(e, host);
    await c.refresh();

    await c.dispatch("promote");
    expect(c.snapshot.canUndo).toBe(false);
    expect(e.promote).not.toHaveBeenCalled();
  });

  it("undoes several steps in reverse order", async () => {
    await controller.dispatch("toggle-done");
    await controller.dispatch("promote");

    await controller.dispatch("undo");
    expect(spy("demote")).toHaveBeenCalled();
    await controller.dispatch("undo");
    expect(spy("toggleDone")).toHaveBeenCalledTimes(2);
    expect(controller.snapshot.canUndo).toBe(false);
  });
});

describe("yank / paste", () => {
  let engine: EnginePort;
  let controller: ListController;

  beforeEach(async () => {
    engine = fakeEngine(TREE);
    controller = new ListController(engine, host);
    await controller.refresh();
  });

  it("paste does nothing before anything is yanked", async () => {
    await controller.dispatch("paste");
    expect(engine.duplicateNode).not.toHaveBeenCalled();
  });

  it("y then P duplicates below the focused row", async () => {
    controller.focus("child-a");
    await controller.dispatch("yank");
    expect(controller.snapshot.yankedId).toBe("child-a");

    controller.focus("second");
    await controller.dispatch("paste");
    // Pasted as a sibling of the *focused* row, not of the yanked one.
    expect(engine.duplicateNode).toHaveBeenCalledWith("child-a", null, "second");
  });

  it("the yank survives so it can be pasted more than once", async () => {
    await controller.dispatch("yank");
    await controller.dispatch("paste");
    await controller.dispatch("paste");
    expect(engine.duplicateNode).toHaveBeenCalledTimes(2);
  });

  it("a paste can be undone", async () => {
    await controller.dispatch("yank");
    await controller.dispatch("paste");
    expect(controller.snapshot.canUndo).toBe(true);

    await controller.dispatch("undo");
    expect(engine.deleteNode).toHaveBeenCalled();
  });
});

describe("creation order", () => {
  it("quick-add appends after the last top-level row", async () => {
    const engine = fakeEngine(TREE);
    const controller = new ListController(engine, host);
    await controller.refresh();

    await controller.dispatch("quick-add");
    // "second", not null: `n` grows downward like every other creation verb, so
    // capturing three things in a row reads top-to-bottom in the order typed.
    expect(engine.createNode).toHaveBeenCalledWith(null, "", "second");
  });

  it("quick-add on an empty list creates the first row", async () => {
    const engine = fakeEngine([]);
    const controller = new ListController(engine, host);
    await controller.refresh();

    await controller.dispatch("quick-add");
    expect(engine.createNode).toHaveBeenCalledWith(null, "", null);
  });

  it("quick-add ignores children when picking the last row", async () => {
    // `child-b` is the last node in the flat tree but it is nested; appending
    // after it would silently make the new capture a sub-item.
    const engine = fakeEngine([
      node({ id: "root", hasChildren: true }),
      node({ id: "child-a", parentId: "root", depth: 1 }),
      node({ id: "child-b", parentId: "root", depth: 1 }),
    ]);
    const controller = new ListController(engine, host);
    await controller.refresh();

    await controller.dispatch("quick-add");
    expect(engine.createNode).toHaveBeenCalledWith(null, "", "root");
  });
});

describe("detail view", () => {
  /** `root` → `child-a` → `grandchild`, plus a sibling `child-b`, plus `second`. */
  const DEEP = [
    node({ id: "root", hasChildren: true }),
    node({ id: "child-a", parentId: "root", depth: 1, hasChildren: true }),
    node({ id: "grandchild", parentId: "child-a", depth: 2 }),
    node({ id: "child-b", parentId: "root", depth: 1 }),
    node({ id: "second" }),
  ];

  async function deep(): Promise<ListController> {
    const c = new ListController(fakeEngine(DEEP), host);
    await c.refresh();
    return c;
  }

  beforeEach(() => {
    host.openDetail.mockClear();
    host.closeDetail.mockClear();
  });

  it("v narrows the list to the focused todo's whole subtree", async () => {
    const c = await deep();
    c.focus("root");
    await c.dispatch("open-detail");
    expect(c.snapshot.detailId).toBe("root");
    expect(c.visible.map((n) => n.id)).toEqual(["child-a", "grandchild", "child-b"]);
  });

  it("focus lands on the first sub-item so j/k are useful straight away", async () => {
    const c = await deep();
    c.focus("root");
    await c.dispatch("open-detail");
    expect(c.snapshot.focusedId).toBe("child-a");

    await c.dispatch("focus-next");
    expect(c.snapshot.focusedId).toBe("grandchild");
  });

  it("a todo with no sub-items opens with nothing focused", async () => {
    const c = await deep();
    c.focus("second");
    await c.dispatch("open-detail");
    expect(c.snapshot.detailId).toBe("second");
    expect(c.visible).toEqual([]);
    expect(c.snapshot.focusedId).toBeNull();
  });

  it("exposes the node and its parent for the backlink chip", async () => {
    const c = await deep();
    c.openDetail("child-a");
    expect(c.detailNode?.id).toBe("child-a");
    expect(c.detailParent?.id).toBe("root");

    c.openDetail("root");
    expect(c.detailParent).toBeNull();
  });

  it("Esc leaves the detail view with that todo focused", async () => {
    const c = await deep();
    c.focus("root");
    await c.dispatch("open-detail");
    await c.dispatch("clear");
    expect(c.snapshot.detailId).toBeNull();
    expect(c.snapshot.focusedId).toBe("root");
    expect(c.visible.map((n) => n.id)).toEqual(DEEP.map((n) => n.id));
  });

  it("Esc closes an overlay before it closes the detail view", async () => {
    const c = await deep();
    c.openDetail("root");
    await c.dispatch("open-tags");
    await c.dispatch("clear");
    expect(c.snapshot.tagEditorOpen).toBe(false);
    expect(c.snapshot.detailId).toBe("root");

    await c.dispatch("clear");
    expect(c.snapshot.detailId).toBeNull();
  });

  it("the host is told to flush before detailId moves", async () => {
    const c = await deep();
    c.openDetail("root");
    host.closeDetail.mockClear();

    c.openDetail("second");
    // Navigating between todos must flush the first one's body while the
    // controller still knows which todo that was.
    expect(host.closeDetail).toHaveBeenCalled();
    expect(c.snapshot.detailId).toBe("second");
  });

  it("saveDetailBody does nothing once the view is closed", async () => {
    const engine = fakeEngine(DEEP);
    const c = new ListController(engine, host);
    await c.refresh();
    c.focus("second");

    // A late flush from an editor being torn down must not land on the row that
    // now has focus.
    c.saveDetailBody("stray text");
    expect(engine.setBody).not.toHaveBeenCalled();
  });

  it("a deleted todo drops the detail view rather than showing a blank page", async () => {
    const engine = fakeEngine(DEEP);
    const c = new ListController(engine, host);
    await c.refresh();
    c.openDetail("root");

    engine.listTree = () => Promise.resolve(DEEP.filter((n) => n.id !== "root"));
    await c.refresh();
    expect(c.snapshot.detailId).toBeNull();
  });

  it("opening a detail view on a node that is gone is a no-op", async () => {
    const c = await deep();
    c.openDetail("nope");
    expect(c.snapshot.detailId).toBeNull();
  });

  it("setStatus reaches states x cannot, and is undoable", async () => {
    const engine = fakeEngine(DEEP);
    const c = new ListController(engine, host);
    await c.refresh();

    const today = localDayKey(new Date());
    await c.setStatus("root", "blocked");
    expect(engine.setStatus).toHaveBeenCalledWith("root", "blocked", today);
    expect(c.snapshot.canUndo).toBe(true);

    await c.dispatch("undo");
    expect(engine.setStatus).toHaveBeenLastCalledWith("root", "todo", today);
  });
});

describe("repeating todos", () => {
  const today = localDayKey(new Date());

  it("passes the host's civil day to toggle-done", async () => {
    const engine = fakeEngine([node({ id: "root" })]);
    const c = new ListController(engine, host);
    await c.refresh();

    await c.dispatch("toggle-done");
    expect(engine.toggleDone).toHaveBeenCalledWith("root", today);
  });

  it("undoing a completion erases the spawned occurrence and returns the rule", async () => {
    const engine = fakeEngine([node({ id: "root", repeatRule: "every monday" })]);
    (engine.toggleDone as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      node({ id: "spawn", scheduledFor: "2026-09-07", repeatRule: "every monday" }),
    );
    const c = new ListController(engine, host);
    await c.refresh();

    await c.dispatch("toggle-done");
    await c.dispatch("undo");

    expect(engine.toggleDone).toHaveBeenCalledTimes(2);
    expect(engine.deleteNode).toHaveBeenCalledWith("spawn");
    expect(engine.setRepeat).toHaveBeenCalledWith("root", "every monday");
  });

  it("undoing a plain completion deletes nothing", async () => {
    const engine = fakeEngine([node({ id: "root" })]);
    const c = new ListController(engine, host);
    await c.refresh();

    await c.dispatch("toggle-done");
    await c.dispatch("undo");

    expect(engine.deleteNode).not.toHaveBeenCalled();
    expect(engine.setRepeat).not.toHaveBeenCalled();
  });

  it("setRepeatRule is undoable back to the previous rule", async () => {
    const engine = fakeEngine([node({ id: "root", repeatRule: "every day" })]);
    const c = new ListController(engine, host);
    await c.refresh();

    await c.setRepeatRule("root", "every 2 weeks");
    expect(engine.setRepeat).toHaveBeenCalledWith("root", "every 2 weeks");

    await c.dispatch("undo");
    expect(engine.setRepeat).toHaveBeenLastCalledWith("root", "every day");
  });

  it("the !every token adopts the rule and plans its first occurrence in one step", async () => {
    const engine = fakeEngine([node({ id: "root" })]);
    const c = new ListController(engine, host);
    await c.refresh();

    await c.applyRepeatRule("root", "every day");
    expect(engine.setRepeat).toHaveBeenCalledWith("root", "every day");
    expect(engine.setScheduled).toHaveBeenCalledWith("root", today);

    // One gesture in, one undo out.
    await c.dispatch("undo");
    expect(engine.setRepeat).toHaveBeenLastCalledWith("root", null);
    expect(engine.setScheduled).toHaveBeenLastCalledWith("root", null);
    expect(c.snapshot.canUndo).toBe(false);
  });
});

describe("abandoned rows from a previous session", () => {
  it("clears blank rows left behind at startup", async () => {
    // A killed app or a closed tab leaves the capture row it opened, and
    // `discardIfEmpty` never got to run. Without this they accumulate forever.
    const engine = fakeEngine([
      node({ id: "real", title: "Real work" }),
      node({ id: "blank", title: "" }),
      node({ id: "blank-2", title: "   " }),
    ]);
    const controller = new ListController(engine, host);
    await controller.refresh();

    await controller.discardAbandonedRows();
    expect(engine.deleteNode).toHaveBeenCalledWith("blank");
    expect(engine.deleteNode).toHaveBeenCalledWith("blank-2");
    expect(engine.deleteNode).not.toHaveBeenCalledWith("real");
  });

  it("keeps a blank row that carries anything at all", async () => {
    const engine = fakeEngine([
      node({ id: "tagged", title: "", tags: [{ id: "t", name: "later", color: "slate" }] }),
      node({ id: "filed", title: "", collectionIds: ["work"] }),
      node({ id: "parent", title: "", hasChildren: true }),
      node({ id: "bodied", title: "", bodyMd: "notes" }),
      node({ id: "done", title: "", status: "done" }),
    ]);
    const controller = new ListController(engine, host);
    await controller.refresh();

    await controller.discardAbandonedRows();
    expect(engine.deleteNode).not.toHaveBeenCalled();
  });

  it("does nothing when there is nothing to clear", async () => {
    const engine = fakeEngine(TREE);
    const controller = new ListController(engine, host);
    await controller.refresh();

    await controller.discardAbandonedRows();
    expect(engine.deleteNode).not.toHaveBeenCalled();
  });
});

describe("EOD report", () => {
  let engine: EnginePort;
  let controller: ListController;

  beforeEach(async () => {
    engine = fakeEngine(TREE);
    controller = new ListController(engine, host);
    await controller.refresh();
  });

  it("Ctrl+Shift+E opens today's report", async () => {
    await controller.dispatch("generate-report");
    expect(controller.snapshot.report).not.toBeNull();
    expect(controller.snapshot.reportDay).toBe(localDayKey(new Date()));
  });

  it("the window is a local day, not a UTC one", async () => {
    await controller.dispatch("generate-report");
    const options = (engine.generateReport as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Exactly 24h apart, and the label matches the local date — anyone east of
    // Greenwich in the evening would otherwise be handed yesterday's report.
    expect(options.toMs - options.fromMs).toBe(86_400_000);
    expect(options.dateLabel).toBe(localDayKey(new Date()));
    expect(options.tzOffsetMinutes).toBe(-new Date().getTimezoneOffset());
  });

  it("the same chord closes it again", async () => {
    await controller.dispatch("generate-report");
    await controller.dispatch("generate-report");
    expect(controller.snapshot.report).toBeNull();
  });

  it("Esc leaves the report", async () => {
    await controller.dispatch("generate-report");
    await controller.dispatch("clear");
    expect(controller.snapshot.report).toBeNull();
  });

  it("Esc closes an overlay before it closes the report", async () => {
    await controller.dispatch("generate-report");
    await controller.dispatch("cheat-sheet");
    await controller.dispatch("clear");
    expect(controller.snapshot.cheatSheetOpen).toBe(false);
    expect(controller.snapshot.report).not.toBeNull();
  });

  it("stepping back a day re-generates for that day", async () => {
    await controller.dispatch("generate-report");
    await controller.shiftReportDay(-1);

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(controller.snapshot.reportDay).toBe(localDayKey(yesterday));
  });

  it("carry-over is recorded for today but not for a past day", async () => {
    const commit = engine.commitCarryOver as ReturnType<typeof vi.fn>;
    engine.generateReport = vi.fn(() =>
      Promise.resolve({
        title: "t",
        markdown: "",
        sections: [],
        counts: { created: 0, updated: 0, completed: 0, carriedOver: 1 },
        carriedOverIds: ["root"],
        duplicated: false,
      }),
    );

    await controller.openReport();
    expect(commit).toHaveBeenCalledTimes(1);

    // Reading history must not append events that change what tomorrow says.
    const past = new Date();
    past.setDate(past.getDate() - 3);
    await controller.openReport(localDayKey(past));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("changing the pivot re-generates for the same day", async () => {
    await controller.dispatch("generate-report");
    const day = controller.snapshot.reportDay;
    await controller.openReport(day, "tag");

    const calls = (engine.generateReport as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1]![0].groupBy).toBe("tag");
    expect(controller.snapshot.reportDay).toBe(day);
  });
});

describe("due dates", () => {
  let engine: EnginePort;
  let controller: ListController;

  beforeEach(async () => {
    engine = fakeEngine(TREE);
    controller = new ListController(engine, host);
    await controller.refresh();
  });

  it("a due date means the END of that local day", async () => {
    await controller.setDue("root", "2026-08-23");
    const ms = (engine.setDue as ReturnType<typeof vi.fn>).mock.calls[0]![1];

    // "Due Friday" means by the end of Friday, not at the midnight it starts.
    const midnight = new Date("2026-08-23T00:00:00").getTime();
    expect(ms).toBeGreaterThan(midnight);
    expect(ms).toBe(new Date("2026-08-24T00:00:00").getTime() - 1);
  });

  it("clearing passes null rather than a zero timestamp", async () => {
    const withDue = TREE.map((n) => (n.id === "root" ? { ...n, dueAt: 123 } : n));
    const e = fakeEngine(withDue);
    const c = new ListController(e, host);
    await c.refresh();

    await c.setDue("root", null);
    expect(e.setDue).toHaveBeenCalledWith("root", null);
  });

  it("setting the same date again does nothing", async () => {
    const day = "2026-08-23";
    const withDue = TREE.map((n) =>
      n.id === "root" ? { ...n, dueAt: endOfLocalDay(day) } : n,
    );
    const e = fakeEngine(withDue);
    const c = new ListController(e, host);
    await c.refresh();

    await c.setDue("root", day);
    expect(e.setDue).not.toHaveBeenCalled();
  });

  it("a due date is undoable", async () => {
    await controller.setDue("root", "2026-08-23");
    expect(controller.snapshot.canUndo).toBe(true);

    await controller.dispatch("undo");
    expect(engine.setDue).toHaveBeenLastCalledWith("root", null);
  });

  it("round-trips through the date input's format", () => {
    expect(dueDayValue(endOfLocalDay("2026-08-23"))).toBe("2026-08-23");
    expect(dueDayValue(null)).toBe("");
  });
});

describe("the rail views", () => {
  const today = localDayKey(new Date());
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return localDayKey(d);
  })();
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return localDayKey(d);
  })();

  it("Today holds the planned, the overdue, and the slipped", () => {
    expect(matchesView(node({ id: "a", scheduledFor: today }), "today")).toBe(true);
    // A plan day that slipped past is still meant to happen.
    expect(matchesView(node({ id: "b", scheduledFor: yesterday }), "today")).toBe(true);
    expect(matchesView(node({ id: "c", dueAt: Date.now() - 1000 }), "today")).toBe(true);
    expect(matchesView(node({ id: "d", scheduledFor: tomorrow }), "today")).toBe(false);
    expect(matchesView(node({ id: "e" }), "today")).toBe(false);
  });

  it("Today keeps what was finished today — a plan that erases wins is a treadmill", () => {
    expect(
      matchesView(node({ id: "a", status: "done", completedAt: Date.now() }), "today"),
    ).toBe(true);
    expect(
      matchesView(
        node({ id: "b", status: "done", completedAt: Date.now() - 3 * 86_400_000 }),
        "today",
      ),
    ).toBe(false);
  });

  it("Upcoming is the future; Anytime is the dateless pool", () => {
    expect(matchesView(node({ id: "a", scheduledFor: tomorrow }), "upcoming")).toBe(true);
    expect(matchesView(node({ id: "b", scheduledFor: today }), "upcoming")).toBe(false);
    expect(matchesView(node({ id: "c" }), "anytime")).toBe(true);
    expect(matchesView(node({ id: "d", scheduledFor: tomorrow }), "anytime")).toBe(false);
  });

  it("All ages finished work out into the Logbook", () => {
    const oldDone = node({ id: "a", status: "done", completedAt: Date.now() - 3 * 86_400_000 });
    const todayDone = node({ id: "b", status: "done", completedAt: Date.now() });
    expect(matchesView(oldDone, "all")).toBe(false);
    expect(matchesView(oldDone, "logbook")).toBe(true);
    expect(matchesView(todayDone, "all")).toBe(true);
  });

  it("selecting a view narrows the visible rows and moves focus into them", async () => {
    const engine = fakeEngine([
      node({ id: "planned", scheduledFor: today }),
      node({ id: "loose" }),
    ]);
    const c = new ListController(engine, host);
    await c.refresh();
    c.focus("loose");

    c.setActiveView("today");
    expect(c.visible.map((n) => n.id)).toEqual(["planned"]);
    expect(c.snapshot.focusedId).toBe("planned");
  });

  it("a view and a collection scope are mutually exclusive", async () => {
    const engine = fakeEngine([node({ id: "a", collectionIds: ["work"] })]);
    engine.listCollections = () =>
      Promise.resolve([
        { id: "work", name: "Work", parentId: null, color: "rose", icon: "", nodeCount: 1 },
      ]);
    const c = new ListController(engine, host);
    await c.refresh();

    c.setActiveCollection("work");
    c.setActiveView("today");
    expect(c.snapshot.activeCollectionId).toBeNull();

    c.setActiveCollection("work");
    expect(c.snapshot.activeView).toBe("all");
  });

  it("capturing inside Today schedules the new row for today", async () => {
    const engine = fakeEngine(TREE);
    const c = new ListController(engine, host);
    await c.refresh();
    c.setActiveView("today");

    await c.dispatch("quick-add");
    expect(engine.setScheduled).toHaveBeenCalledWith("new", today);
  });
});

describe("the schedule popover", () => {
  let engine: EnginePort;
  let controller: ListController;

  function press(key: string) {
    return controller.handleKey({
      key,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault: () => {},
    } as unknown as KeyboardEvent);
  }

  beforeEach(async () => {
    engine = fakeEngine(TREE);
    controller = new ListController(engine, host);
    await controller.refresh();
  });

  it("s opens it, t schedules today, and it closes", async () => {
    press("s");
    expect(controller.snapshot.schedulePopoverOpen).toBe(true);

    press("t");
    await Promise.resolve();
    expect(engine.setScheduled).toHaveBeenCalledWith("root", localDayKey(new Date()));
    expect(controller.snapshot.schedulePopoverOpen).toBe(false);
  });

  it("m is tomorrow, w is next Monday, x clears", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    press("s");
    press("m");
    await Promise.resolve();
    expect(engine.setScheduled).toHaveBeenLastCalledWith("root", localDayKey(tomorrow));

    press("s");
    press("w");
    await Promise.resolve();
    expect(engine.setScheduled).toHaveBeenLastCalledWith("root", nextMondayKey());

    // Clearing needs something to clear — the fake tree never persists the
    // earlier writes, and clearing an already-null plan is rightly a no-op.
    const scheduled = fakeEngine([node({ id: "planned", scheduledFor: "2026-09-01" })]);
    const c2 = new ListController(scheduled, host);
    await c2.refresh();
    c2.handleKey({ key: "s", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => {} } as unknown as KeyboardEvent);
    c2.handleKey({ key: "x", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => {} } as unknown as KeyboardEvent);
    await Promise.resolve();
    expect(scheduled.setScheduled).toHaveBeenLastCalledWith("planned", null);
  });

  it("Escape closes it without scheduling anything", () => {
    press("s");
    press("Escape");
    expect(controller.snapshot.schedulePopoverOpen).toBe(false);
    expect(engine.setScheduled).not.toHaveBeenCalled();
  });

  it("while open, t means today — not the tag editor", () => {
    press("s");
    press("t");
    expect(controller.snapshot.tagEditorOpen).toBe(false);
  });

  it("scheduling is undoable", async () => {
    await controller.scheduleFocused("2026-09-01");
    expect(controller.snapshot.canUndo).toBe(true);
    await controller.dispatch("undo");
    expect(engine.setScheduled).toHaveBeenLastCalledWith("root", null);
  });

  it("next Monday is strictly after today", () => {
    const key = nextMondayKey();
    expect(key > localDayKey(new Date())).toBe(true);
    expect(new Date(`${key}T00:00:00`).getDay()).toBe(1);
  });
});

describe("collection sidebar", () => {
  /** `root` and `child-a` are in Work; `second` is in Home. */
  const SCOPED = [
    node({ id: "root", hasChildren: true, collectionIds: ["work"] }),
    node({ id: "child-a", parentId: "root", depth: 1, collectionIds: ["work"] }),
    node({ id: "child-b", parentId: "root", depth: 1 }),
    node({ id: "second", collectionIds: ["home"] }),
  ];
  const COLLECTIONS = [
    { id: "work", name: "Work", parentId: null, color: "rose", icon: "", nodeCount: 2 },
    { id: "home", name: "Home", parentId: null, color: "cyan", icon: "", nodeCount: 1 },
  ];

  function scoped(): { engine: EnginePort; controller: ListController } {
    const engine = fakeEngine(SCOPED);
    engine.listCollections = () => Promise.resolve(COLLECTIONS);
    return { engine, controller: new ListController(engine, host) };
  }

  it("All shows everything", async () => {
    const { controller } = scoped();
    await controller.refresh();
    expect(controller.visible).toHaveLength(4);
  });

  it("a scope keeps members and their ancestors", async () => {
    const { controller } = scoped();
    await controller.refresh();
    controller.setActiveCollection("work");
    expect(controller.visible.map((n) => n.id)).toEqual(["root", "child-a"]);
  });

  it("a scoped member drags in a parent that is not itself a member", async () => {
    const { controller } = scoped();
    await controller.refresh();
    // `child-b` is not in Home, but `second` is — and `second` has no parent, so
    // use a case where the parent really is absent from the collection.
    const engine = fakeEngine([
      node({ id: "p", hasChildren: true }),
      node({ id: "c", parentId: "p", depth: 1, collectionIds: ["work"] }),
    ]);
    engine.listCollections = () => Promise.resolve(COLLECTIONS);
    const c = new ListController(engine, host);
    await c.refresh();
    c.setActiveCollection("work");
    expect(c.visible.map((n) => n.id)).toEqual(["p", "c"]);
  });

  it("the scope and the search compose", async () => {
    const { controller } = scoped();
    await controller.refresh();
    controller.setActiveCollection("work");
    controller.setQuery("child-a");
    expect(controller.visible.map((n) => n.id)).toEqual(["root", "child-a"]);

    controller.setQuery("second");
    // `second` matches the search but is not in Work, so nothing survives both.
    expect(controller.visible).toHaveLength(0);
  });

  it("focus follows the scope when the focused row goes out of view", async () => {
    const { controller } = scoped();
    await controller.refresh();
    controller.focus("second");
    controller.setActiveCollection("work");
    expect(controller.snapshot.focusedId).toBe("root");
  });

  it("digits address the sidebar rows, views first", async () => {
    const { controller } = scoped();
    await controller.refresh();

    // Rows are Today, Upcoming, Anytime, All, Logbook, then collections.
    await controller.dispatch("select-collection", "6");
    expect(controller.snapshot.activeCollectionId).toBe("work");

    await controller.dispatch("select-collection", "1");
    expect(controller.snapshot.activeView).toBe("today");
    expect(controller.snapshot.activeCollectionId).toBeNull();

    await controller.dispatch("select-collection", "4");
    expect(controller.snapshot.activeView).toBe("all");
  });

  it("a digit past the last row is a no-op, not a reset", async () => {
    const { controller } = scoped();
    await controller.refresh();
    await controller.dispatch("select-collection", "6");
    await controller.dispatch("select-collection", "9");
    expect(controller.snapshot.activeCollectionId).toBe("work");
  });

  it("counts only open items", async () => {
    const engine = fakeEngine([
      node({ id: "a", collectionIds: ["work"] }),
      node({ id: "b", collectionIds: ["work"], status: "done" }),
      node({ id: "c", collectionIds: ["work"], status: "dropped" }),
    ]);
    engine.listCollections = () => Promise.resolve(COLLECTIONS);
    const controller = new ListController(engine, host);
    await controller.refresh();

    const rows = controller.sidebarRows;
    expect(rows[3]).toMatchObject({ kind: "view", view: "all", count: 1 });
    expect(rows[5]).toMatchObject({ kind: "collection", id: "work", count: 1 });
  });

  it("a scope that no longer exists is dropped on refresh", async () => {
    const { engine, controller } = scoped();
    await controller.refresh();
    controller.setActiveCollection("work");

    engine.listCollections = () => Promise.resolve([COLLECTIONS[1]!]);
    await controller.refresh();
    expect(controller.snapshot.activeCollectionId).toBeNull();
  });

  it("creating inside a scope files the new node into it", async () => {
    const { engine, controller } = scoped();
    await controller.refresh();
    controller.setActiveCollection("work");

    await controller.dispatch("quick-add");
    // Otherwise the new row is created and immediately filtered back out.
    expect(engine.addToCollection).toHaveBeenCalledWith("new", "work");
  });

  it("the scope's own collection does not make a blank row un-discardable", async () => {
    const engine = fakeEngine([node({ id: "blank", title: "", collectionIds: ["work"] })]);
    engine.listCollections = () => Promise.resolve(COLLECTIONS);
    const controller = new ListController(engine, host);
    await controller.refresh();
    controller.setActiveCollection("work");

    controller.focus("blank");
    controller.enterEdit("blank");
    await controller.exitEdit();
    expect(engine.deleteNode).toHaveBeenCalledWith("blank");
  });

  it("a hand-filed collection still counts as content", async () => {
    const engine = fakeEngine([node({ id: "filed", title: "", collectionIds: ["home"] })]);
    engine.listCollections = () => Promise.resolve(COLLECTIONS);
    const controller = new ListController(engine, host);
    await controller.refresh();
    controller.setActiveCollection("work");

    controller.focus("filed");
    controller.enterEdit("filed");
    await controller.exitEdit();
    expect(engine.deleteNode).not.toHaveBeenCalled();
  });

  it("Ctrl+B toggles the rail", async () => {
    const { controller } = scoped();
    await controller.refresh();
    expect(controller.snapshot.sidebarCollapsed).toBe(false);
    await controller.dispatch("toggle-sidebar");
    expect(controller.snapshot.sidebarCollapsed).toBe(true);
  });
});

describe("error surfacing", () => {
  it("puts an engine failure into state rather than swallowing it", async () => {
    const engine = fakeEngine(TREE);
    (engine.toggleDone as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("engine exploded"),
    );
    const c = new ListController(engine, host);
    await c.refresh();

    await c.dispatch("toggle-done");
    expect(c.snapshot.error).toBe("engine exploded");
    expect(c.snapshot.busy).toBe(false);
  });
});
