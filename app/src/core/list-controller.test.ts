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
