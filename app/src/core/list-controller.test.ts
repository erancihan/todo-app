import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListController } from "./list-controller";
import type { EnginePort, NodeView } from "./engine-port";

/**
 * A fake engine holding a flat tree, so the controller's own logic — visibility,
 * focus movement, mode — is tested without SQLite or wasm in the way. The engine
 * itself is tested in Rust; what is under test here is the glue.
 */
function node(partial: Partial<NodeView> & { id: string }): NodeView {
  return {
    parentId: null,
    kind: "task",
    promoted: false,
    title: partial.id,
    bodyMd: "",
    status: "todo",
    orderKey: partial.id,
    createdAt: 0,
    updatedAt: 0,
    dueAt: null,
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
    setStatus: vi.fn(stub),
    toggleDone: vi.fn(stub),
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
    addToCollection: vi.fn(stub),
    removeFromCollection: vi.fn(stub),
    eventsBetween: () => Promise.resolve([]),
    eventsForNode: () => Promise.resolve([]),
  } as unknown as EnginePort;
}

const host = { openEditor: vi.fn(), closeEditor: vi.fn(), editorText: () => "" };

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
