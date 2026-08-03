/**
 * The keymap, as data (docs/04-ux-and-interaction.md §4).
 *
 * Part of the framework-agnostic plain-TS core: this module resolves a raw
 * `KeyboardEvent` into an intent and knows nothing about Alpine, CodeMirror, or
 * the DOM tree. Both the app and the Phase 0 keymap harness in
 * `spikes/cm6-keymap/` drive *this* resolver, so the spike proves the shipped
 * behaviour rather than a lookalike.
 *
 * The two modes are what make the required bindings unambiguous: `Enter` can mean
 * "newline" in EDIT and "open row" in LIST because LIST has no text caret.
 */

export type Mode = "list" | "edit";

/** Every verb the keymap can produce. */
export type Action =
  // --- LIST mode ---
  | "focus-next"
  | "focus-prev"
  | "collapse-or-parent"
  | "expand-or-child"
  | "jump-first"
  | "jump-last"
  | "edit"
  | "new-sibling-below"
  | "new-sibling-above"
  | "new-subitem"
  | "indent"
  | "outdent"
  | "toggle-done"
  | "promote"
  | "open-tags"
  | "open-collections"
  | "delete"
  | "undo"
  | "redo"
  | "focus-search"
  | "quick-add"
  | "clear"
  // --- EDIT mode ---
  | "newline"
  | "submit"
  | "exit-edit"
  | "caret-move"
  // --- Global ---
  | "command-palette"
  | "generate-report"
  | "search"
  | "cheat-sheet";

/**
 * The three bindings the PRD marks **[REQUIRED]**. Kept as an exported constant so
 * a test can assert them by name instead of restating the expectation.
 */
export const REQUIRED_EDIT_BINDINGS = {
  newline: ["Enter", "Shift+Enter"],
  submit: ["Ctrl+Enter", "Cmd+Enter"],
} as const;

/** Normalized view of a key event, so resolution is testable without a real DOM. */
export interface KeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export function fromEvent(e: KeyboardEvent): KeyInput {
  return {
    key: e.key,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
  };
}

/** `Ctrl` on Windows/Linux, `Cmd` on Apple platforms — either satisfies the binding. */
function primaryModifier(k: KeyInput): boolean {
  return k.ctrlKey || k.metaKey;
}

/** Bindings that fire in either mode (docs §4.3). Checked before mode bindings. */
function resolveGlobal(k: KeyInput): Action | null {
  if (primaryModifier(k) && k.shiftKey && (k.key === "E" || k.key === "e")) {
    return "generate-report";
  }
  if (primaryModifier(k) && k.key === "k") return "command-palette";
  if (primaryModifier(k) && k.key === "f") return "search";
  return null;
}

/** EDIT mode — the CodeMirror body is active and owns the caret (docs §4.2). */
function resolveEdit(k: KeyInput): Action | null {
  if (k.key === "Enter") {
    // Order matters: the modifier check must come first, or `Ctrl+Enter` would be
    // swallowed as a newline and the todo could never be submitted.
    if (primaryModifier(k)) return "submit";
    // Plain AND Shift both insert a newline. This is the notepad promise, and on
    // mobile it is what keeps the soft `Return` key safe.
    return "newline";
  }
  if (k.key === "Escape") return "exit-edit";
  if (k.key === "Tab") return k.shiftKey ? "outdent" : "indent";
  // Arrows move the text caret in EDIT mode — they must never navigate rows.
  if (k.key.startsWith("Arrow")) return "caret-move";
  return null;
}

/** LIST mode — one row is focused, there is no text caret (docs §4.1). */
function resolveList(k: KeyInput): Action | null {
  if (primaryModifier(k)) {
    if (k.key === "n") return "quick-add";
    if (k.key === "z") return k.shiftKey ? "redo" : "undo";
    if (k.key === "y") return "redo";
    return null;
  }

  switch (k.key) {
    case "ArrowDown":
    case "j":
      return "focus-next";
    case "ArrowUp":
    case "k":
      return "focus-prev";
    case "ArrowLeft":
    case "h":
      return "collapse-or-parent";
    case "ArrowRight":
    case "l":
      return "expand-or-child";
    case "G":
      return "jump-last";
    case "e":
    case "Enter":
      return "edit";
    case "o":
      return "new-sibling-below";
    case "O":
      return "new-sibling-above";
    case "a":
      return "new-subitem";
    case "Tab":
      return k.shiftKey ? "outdent" : "indent";
    case " ":
    case "x":
      return "toggle-done";
    case "p":
      return "promote";
    case "t":
      return "open-tags";
    case "c":
      return "open-collections";
    case "u":
      return "undo";
    case "/":
      return "focus-search";
    case "n":
      return "quick-add";
    case "?":
      return "cheat-sheet";
    case "Escape":
      return "clear";
    default:
      return null;
  }
}

/**
 * Resolve a key press to an intent, or `null` when the key is not bound and should
 * be left alone (in EDIT mode that means "let CodeMirror type it").
 *
 * Multi-key sequences (`gg`, `dd`) are not handled here — they need a pending-key
 * buffer, which lands with the Phase 1 list controller.
 */
export function resolve(k: KeyInput, mode: Mode): Action | null {
  return resolveGlobal(k) ?? (mode === "edit" ? resolveEdit(k) : resolveList(k));
}

/**
 * Whether the host should call `preventDefault()`. `newline` and `caret-move` are
 * deliberately excluded: those are the browser's own job, and hijacking them is
 * what breaks IME composition and the mobile soft keyboard.
 */
export function shouldPreventDefault(action: Action): boolean {
  return action !== "newline" && action !== "caret-move";
}
