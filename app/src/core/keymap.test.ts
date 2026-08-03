import { describe, expect, it } from "vitest";
import { resolve, shouldPreventDefault, type KeyInput, type Mode } from "./keymap";

function key(k: string, mods: Partial<Omit<KeyInput, "key">> = {}): KeyInput {
  return {
    key: k,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  };
}

/**
 * The bindings docs/04-ux-and-interaction.md marks **[REQUIRED]**. If any of these
 * regress, the capture loop is broken — on mobile, unrecoverably so.
 */
describe("required bindings", () => {
  it("Enter inserts a newline while composing", () => {
    expect(resolve(key("Enter"), "edit")).toBe("newline");
  });

  it("Shift+Enter also inserts a newline", () => {
    expect(resolve(key("Enter", { shiftKey: true }), "edit")).toBe("newline");
  });

  it("Ctrl+Enter submits", () => {
    expect(resolve(key("Enter", { ctrlKey: true }), "edit")).toBe("submit");
  });

  it("Cmd+Enter submits, for parity on Apple platforms", () => {
    expect(resolve(key("Enter", { metaKey: true }), "edit")).toBe("submit");
  });

  it("never lets a modified Enter fall through as a newline", () => {
    // The ordering bug this guards: check the modifier before the plain case, or
    // Ctrl+Enter types a newline and the todo can never be submitted.
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(resolve(key("Enter", { ...mods, shiftKey: true }), "edit")).toBe("submit");
    }
  });

  it("leaves the newline keystroke to the browser", () => {
    // preventDefault on Enter breaks IME composition and the mobile soft keyboard.
    expect(shouldPreventDefault("newline")).toBe(false);
    expect(shouldPreventDefault("submit")).toBe(true);
  });

  it("e edits the focused row in LIST mode", () => {
    expect(resolve(key("e"), "list")).toBe("edit");
  });
});

describe("mode separation", () => {
  it("arrows navigate rows in LIST and move the caret in EDIT", () => {
    expect(resolve(key("ArrowDown"), "list")).toBe("focus-next");
    expect(resolve(key("ArrowUp"), "list")).toBe("focus-prev");
    expect(resolve(key("ArrowDown"), "edit")).toBe("caret-move");
    expect(resolve(key("ArrowUp"), "edit")).toBe("caret-move");
  });

  it("Enter opens a row in LIST but composes in EDIT", () => {
    expect(resolve(key("Enter"), "list")).toBe("edit");
    expect(resolve(key("Enter"), "edit")).toBe("newline");
  });

  it("j/k navigate only in LIST — in EDIT they are literal text", () => {
    expect(resolve(key("j"), "list")).toBe("focus-next");
    expect(resolve(key("k"), "list")).toBe("focus-prev");
    expect(resolve(key("j"), "edit")).toBeNull();
    expect(resolve(key("k"), "edit")).toBeNull();
  });

  it("single-letter verbs never fire while composing", () => {
    for (const k of ["x", "p", "t", "c", "o", "a", "e", "u", "/", "?"]) {
      expect(resolve(key(k), "edit")).toBeNull();
    }
  });
});

describe("LIST mode verbs", () => {
  it.each([
    ["x", "toggle-done"],
    [" ", "toggle-done"],
    ["p", "promote"],
    ["o", "new-sibling-below"],
    ["O", "new-sibling-above"],
    ["a", "new-subitem"],
    ["t", "open-tags"],
    ["c", "open-collections"],
    ["/", "focus-search"],
    ["?", "cheat-sheet"],
    ["G", "jump-last"],
  ])("%s -> %s", (k, action) => {
    expect(resolve(key(k), "list")).toBe(action);
  });

  it("Tab indents and Shift+Tab outdents", () => {
    expect(resolve(key("Tab"), "list")).toBe("indent");
    expect(resolve(key("Tab", { shiftKey: true }), "list")).toBe("outdent");
    expect(resolve(key("Tab"), "edit")).toBe("indent");
    expect(resolve(key("Tab", { shiftKey: true }), "edit")).toBe("outdent");
  });

  it("Escape leaves EDIT but only clears in LIST", () => {
    expect(resolve(key("Escape"), "edit")).toBe("exit-edit");
    expect(resolve(key("Escape"), "list")).toBe("clear");
  });
});

describe("global bindings", () => {
  const modes: Mode[] = ["list", "edit"];

  it("Ctrl/Cmd+K opens the palette in either mode", () => {
    for (const mode of modes) {
      expect(resolve(key("k", { ctrlKey: true }), mode)).toBe("command-palette");
      expect(resolve(key("k", { metaKey: true }), mode)).toBe("command-palette");
    }
  });

  it("Ctrl/Cmd+Shift+E generates the EOD report in either mode", () => {
    for (const mode of modes) {
      expect(resolve(key("E", { ctrlKey: true, shiftKey: true }), mode)).toBe("generate-report");
    }
  });

  it("global bindings win over mode bindings", () => {
    // Ctrl+K must not be read as LIST-mode `k` (focus-prev).
    expect(resolve(key("k", { ctrlKey: true }), "list")).toBe("command-palette");
  });
});

describe("unbound keys", () => {
  it("returns null so ordinary typing reaches the editor", () => {
    for (const k of ["q", "Z", "1", "F5"]) {
      expect(resolve(key(k), "edit")).toBeNull();
    }
  });
});
