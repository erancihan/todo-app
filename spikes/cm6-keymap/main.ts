/**
 * Spike 3 — CodeMirror 6 keymap harness (throwaway).
 *
 * Proves the two Phase 0 keyboard criteria in a plain browser page:
 *   1. `Enter`/`Shift+Enter` insert a newline; `Ctrl/Cmd+Enter` submits.
 *   2. Arrow keys hand off cleanly between the list and the editor — rows in LIST,
 *      caret in EDIT, with no leakage in either direction.
 *
 * The list-side bindings are resolved by the **real** keymap module
 * (`app/src/core/keymap.ts`), so this harness exercises shipped logic rather than
 * a lookalike. Only the CodeMirror wiring and the page chrome are throwaway.
 */

import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { insertNewlineAndIndent } from "@codemirror/commands";

import { resolve, shouldPreventDefault, fromEvent, type Mode } from "../../app/src/core/keymap";

// --- state -----------------------------------------------------------------

let mode: Mode = "list";
let focusedRow = 0;
/** Bumped by every successful submit, so assertions can detect one. */
let submitCount = 0;

const listEl = document.getElementById("list") as HTMLUListElement;
const modeEl = document.getElementById("mode") as HTMLDivElement;
const rows = () => Array.from(listEl.querySelectorAll("li"));

function setMode(next: Mode) {
  mode = next;
  modeEl.textContent = next.toUpperCase();
  if (next === "edit") view.focus();
  else listEl.focus();
}

function paintRows() {
  rows().forEach((li, i) => li.setAttribute("aria-selected", String(i === focusedRow)));
}

// --- editor ----------------------------------------------------------------

/** `Ctrl/Cmd+Enter` = submit. Registered ahead of the default keymap. */
function submit(): boolean {
  submitCount += 1;
  setMode("list");
  return true;
}

const daybookKeymap = keymap.of([
  // Precedence matters: these entries must be seen before `defaultKeymap`, or
  // Enter's default binding would claim the modified form too.
  //
  // All three forms are bound deliberately. CodeMirror's `Mod` resolves to Cmd on
  // macOS and Ctrl everywhere else, via its own platform sniffing — so a lone
  // `Mod-Enter` makes submit depend on that sniffing being right inside every
  // WebView in the matrix. Binding `Ctrl-Enter` and `Cmd-Enter` outright means
  // submit works even if the platform is misdetected, and matches the app's own
  // resolver (`app/src/core/keymap.ts`), which accepts either modifier.
  { key: "Mod-Enter", run: submit, preventDefault: true },
  { key: "Ctrl-Enter", run: submit, preventDefault: true },
  { key: "Cmd-Enter", run: submit, preventDefault: true },
  // Both plain and Shift Enter insert a newline. `defaultKeymap` already binds
  // Enter; Shift-Enter is bound explicitly so it can never fall through to a
  // "submit" interpretation on any engine.
  { key: "Enter", run: insertNewlineAndIndent },
  { key: "Shift-Enter", run: insertNewlineAndIndent },
  {
    key: "Escape",
    run: () => {
      setMode("list");
      return true;
    },
    preventDefault: true,
  },
]);

const view = new EditorView({
  parent: document.getElementById("editor") as HTMLElement,
  state: EditorState.create({
    doc: "## Ship EOD report v1\n\nGrouped markdown export from the event log.",
    extensions: [
      history(),
      // `daybookKeymap` first — CodeMirror resolves keymaps in order.
      daybookKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      EditorView.lineWrapping,
      EditorView.theme({ "&": { backgroundColor: "#131518", color: "#e9ecf1" } }, { dark: true }),
    ],
  }),
});

// --- list ------------------------------------------------------------------

listEl.addEventListener("keydown", (e) => {
  if (mode !== "list") return;
  const action = resolve(fromEvent(e), "list");
  if (!action) return;
  if (shouldPreventDefault(action)) e.preventDefault();

  switch (action) {
    case "focus-next":
      focusedRow = Math.min(focusedRow + 1, rows().length - 1);
      paintRows();
      break;
    case "focus-prev":
      focusedRow = Math.max(focusedRow - 1, 0);
      paintRows();
      break;
    case "edit":
      setMode("edit");
      break;
    default:
      break;
  }
});

rows().forEach((li, i) =>
  li.addEventListener("click", () => {
    focusedRow = i;
    paintRows();
    setMode("edit");
  }),
);

// Mobile accessory bar: the on-screen Submit that exists precisely so the soft
// `Return` key can stay a newline.
document.getElementById("acc-submit")?.addEventListener("click", () => submit());
document.getElementById("acc-done")?.addEventListener("click", () => setMode("list"));

paintRows();
setMode("list");

// --- assertions ------------------------------------------------------------

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];
const log: string[] = [];

function check(name: string, passed: boolean, detail = "") {
  checks.push({ name, passed, detail });
}

/** Dispatch a real `keydown` at CodeMirror's content DOM. */
function pressInEditor(key: string, mods: Partial<KeyboardEventInit> = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
  );
}

function pressInList(key: string, mods: Partial<KeyboardEventInit> = {}) {
  listEl.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
  );
}

function resetEditor(doc = "line one") {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  view.dispatch({ selection: { anchor: view.state.doc.length } });
}

function runChecks() {
  checks.length = 0;
  log.length = 0;

  // 1 — Enter inserts a newline and does not submit.
  setMode("edit");
  resetEditor();
  let before = view.state.doc.lines;
  let submitsBefore = submitCount;
  pressInEditor("Enter");
  check(
    "Enter inserts a newline (does not submit)",
    view.state.doc.lines === before + 1 && submitCount === submitsBefore,
    `lines ${before} → ${view.state.doc.lines}, submits ${submitsBefore} → ${submitCount}`,
  );

  // 2 — Shift+Enter also inserts a newline.
  setMode("edit");
  resetEditor();
  before = view.state.doc.lines;
  submitsBefore = submitCount;
  pressInEditor("Enter", { shiftKey: true });
  check(
    "Shift+Enter inserts a newline (does not submit)",
    view.state.doc.lines === before + 1 && submitCount === submitsBefore,
    `lines ${before} → ${view.state.doc.lines}, submits ${submitsBefore} → ${submitCount}`,
  );

  // 3 — Ctrl+Enter submits and inserts nothing.
  setMode("edit");
  resetEditor();
  before = view.state.doc.lines;
  submitsBefore = submitCount;
  pressInEditor("Enter", { ctrlKey: true });
  check(
    "Ctrl+Enter submits and inserts no newline",
    submitCount === submitsBefore + 1 && view.state.doc.lines === before,
    `lines ${before} → ${view.state.doc.lines}, submits ${submitsBefore} → ${submitCount}`,
  );

  // 4 — Cmd+Enter submits too (the macOS/iOS form of the same binding).
  setMode("edit");
  resetEditor();
  before = view.state.doc.lines;
  submitsBefore = submitCount;
  pressInEditor("Enter", { metaKey: true });
  check(
    "Cmd+Enter submits and inserts no newline",
    submitCount === submitsBefore + 1 && view.state.doc.lines === before,
    `lines ${before} → ${view.state.doc.lines}, submits ${submitsBefore} → ${submitCount}`,
  );

  // 5 — submit returns to LIST mode.
  check("Submit drops back to LIST mode", mode === "list", `mode = ${mode}`);

  // 6 — arrows in LIST move row focus and leave the editor caret alone.
  setMode("list");
  focusedRow = 0;
  paintRows();
  const caretBefore = view.state.selection.main.head;
  pressInList("ArrowDown");
  const rowAfterDown = focusedRow;
  pressInList("ArrowUp");
  check(
    "Arrows navigate rows in LIST without moving the caret",
    rowAfterDown === 1 && focusedRow === 0 && view.state.selection.main.head === caretBefore,
    `row 0 → ${rowAfterDown} → ${focusedRow}, caret ${caretBefore} → ${view.state.selection.main.head}`,
  );

  // 7 — arrows in EDIT move the caret and leave row focus alone.
  setMode("edit");
  resetEditor("alpha\nbravo\ncharlie");
  view.dispatch({ selection: { anchor: 0 } });
  const rowBefore = focusedRow;
  const caretStart = view.state.selection.main.head;
  pressInEditor("ArrowDown");
  const caretMoved = view.state.selection.main.head !== caretStart;
  check(
    "Arrows move the caret in EDIT without navigating rows",
    caretMoved && focusedRow === rowBefore,
    `caret ${caretStart} → ${view.state.selection.main.head}, row ${rowBefore} → ${focusedRow}`,
  );

  // 8 — `e` hands focus from the list to the editor.
  setMode("list");
  pressInList("e");
  check(
    "`e` hands focus from the list to the editor",
    mode === "edit" && view.hasFocus,
    `mode = ${mode}, editor focused = ${view.hasFocus}`,
  );

  // 9 — Esc hands focus back.
  pressInEditor("Escape");
  check(
    "Esc hands focus back to the list",
    mode === "list" && document.activeElement === listEl,
    `mode = ${mode}, activeElement = ${document.activeElement?.tagName}`,
  );

  // 10 — Enter in LIST opens the row rather than typing.
  setMode("list");
  pressInList("Enter");
  check("Enter opens the focused row in LIST", mode === "edit", `mode = ${mode}`);

  setMode("list");
  render();
}

function render() {
  const table = document.getElementById("results") as HTMLTableElement;
  table.innerHTML = checks
    .map(
      (c) => `<tr>
        <td class="verdict ${c.passed ? "pass" : "fail"}">${c.passed ? "PASS" : "FAIL"}</td>
        <td>${c.name}<br><span style="color:var(--muted);font:11px ui-monospace,monospace">${c.detail}</span></td>
      </tr>`,
    )
    .join("");

  const failed = checks.filter((c) => !c.passed);
  const summary = document.getElementById("summary") as HTMLElement;
  summary.textContent = failed.length
    ? `${failed.length} of ${checks.length} checks FAILED on ${navigator.userAgent}`
    : `All ${checks.length} checks passed — ${navigator.userAgent}`;
  summary.className = failed.length ? "fail" : "pass";

  (document.getElementById("log") as HTMLElement).textContent = log.join("\n");

  // Machine-readable hook for the headless runner.
  (window as unknown as Record<string, unknown>).__SPIKE_RESULT__ = {
    total: checks.length,
    failed: failed.length,
    checks,
    userAgent: navigator.userAgent,
  };
}

document.getElementById("rerun")?.addEventListener("click", runChecks);
runChecks();
