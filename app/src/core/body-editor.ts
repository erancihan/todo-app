/**
 * The CodeMirror 6 markdown body editor.
 *
 * A plain-TS module, not an Alpine component: it is one of the heavy surfaces the
 * architecture explicitly keeps out of the view layer (docs/02-architecture.md
 * ADR-001). Alpine positions it; this file owns it.
 *
 * The bindings here mirror `keymap.ts` rather than re-deriving them, because
 * CodeMirror resolves keys itself and would otherwise be a second, divergent
 * source of truth for the three bindings the PRD marks **[REQUIRED]**.
 */

import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { livePreview } from "./live-preview";

export interface BodyEditorCallbacks {
  /** `Ctrl/Cmd+Enter`. */
  onSubmit(): void;
  /** `Esc`. */
  onExit(): void;
  /** Debounced autosave — the body is never lost by leaving it alone. */
  onChange(text: string): void;
}

/** How long typing must pause before an autosave fires. */
const AUTOSAVE_MS = 400;

/**
 * Wrap (or unwrap) each selection in a markdown marker — `Ctrl/Cmd+B` and `+I`.
 *
 * Toggling matters: pressing bold twice should give back the plain text, not
 * `****text****`. With an empty selection it inserts the markers and puts the
 * caret between them, so you can just start typing bold.
 */
function wrapSelection(view: EditorView, marker: string): boolean {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const width = marker.length;
      const surrounding = view.state.sliceDoc(range.from - width, range.to + width);
      const alreadyWrapped =
        surrounding === `${marker}${text}${marker}` ||
        (text.startsWith(marker) && text.endsWith(marker) && text.length > width * 2);

      if (alreadyWrapped && text.startsWith(marker)) {
        const inner = text.slice(width, -width);
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length),
        };
      }
      if (alreadyWrapped) {
        return {
          changes: { from: range.from - width, to: range.to + width, insert: text },
          range: EditorSelection.range(range.from - width, range.to - width + text.length),
        };
      }
      return {
        changes: { from: range.from, to: range.to, insert: `${marker}${text}${marker}` },
        range: text
          ? EditorSelection.range(range.from + width, range.to + width)
          : EditorSelection.cursor(range.from + width),
      };
    }),
  );
  return true;
}

export class BodyEditor {
  private view: EditorView;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    parent: HTMLElement,
    private callbacks: BodyEditorCallbacks,
  ) {
    this.view = new EditorView({ parent, state: this.buildState("") });
  }

  private buildState(doc: string): EditorState {
    return EditorState.create({ doc, extensions: this.extensions() });
  }

  private extensions(): Extension[] {
    return [
      history(),
      // Ours first: CodeMirror resolves keymaps in order, and `defaultKeymap`
      // binds Enter. Registering after it would let the default claim the
      // modified forms too.
      keymap.of([
        // All three forms bound explicitly. CodeMirror's `Mod` resolves to Cmd on
        // macOS and Ctrl elsewhere via its own platform sniffing, so a lone
        // `Mod-Enter` makes submit depend on that sniffing being right inside
        // every WebView in the matrix. This was a real failure in the Phase 0
        // harness, not a hypothetical.
        { key: "Mod-Enter", run: () => this.submit(), preventDefault: true },
        { key: "Ctrl-Enter", run: () => this.submit(), preventDefault: true },
        { key: "Cmd-Enter", run: () => this.submit(), preventDefault: true },
        // Enter and Shift+Enter both insert a newline. This is the notepad
        // promise, and on mobile it is what keeps the soft Return key safe.
        { key: "Enter", run: insertNewlineAndIndent },
        { key: "Shift-Enter", run: insertNewlineAndIndent },
        { key: "Mod-b", run: (view) => wrapSelection(view, "**"), preventDefault: true },
        { key: "Mod-i", run: (view) => wrapSelection(view, "*"), preventDefault: true },
        {
          key: "Escape",
          run: () => {
            this.flush();
            this.callbacks.onExit();
            return true;
          },
          preventDefault: true,
        },
      ]),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      livePreview(),
      EditorView.lineWrapping,
      placeholder("Write markdown… Ctrl/Cmd+Enter to submit"),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.scheduleSave();
      }),
      EditorView.theme(
        {
          "&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "1rem" },
          ".cm-content": {
            padding: "8px 0",
            caretColor: "var(--primary)",
            // CodeMirror's base theme makes everything monospace — reasonable for
            // a code editor, wrong for a notepad. Bodies are prose; `live-preview`
            // puts code spans and fences back into `--font-mono`.
            fontFamily: "var(--font-sans)",
          },
          "&.cm-focused": { outline: "none" },
          ".cm-line": { padding: "0 2px" },
          ".cm-placeholder": { color: "var(--muted-foreground)" },
        },
        { dark: true },
      ),
    ];
  }

  private submit(): boolean {
    this.flush();
    this.callbacks.onSubmit();
    return true;
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), AUTOSAVE_MS);
  }

  /** Save now, cancelling any pending debounce. */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.callbacks.onChange(this.text());
  }

  /** Load a body and put the caret at the end, ready to keep typing. */
  load(text: string) {
    this.view.setState(this.buildState(text));
    this.view.dispatch({ selection: { anchor: this.view.state.doc.length } });
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  /**
   * The editor's root element. Exposed so the view can move one editor instance
   * between rows rather than tearing down CodeMirror on every focus change —
   * rebuilding it per row would drop undo history and cost a frame each time.
   */
  get element(): HTMLElement {
    return this.view.dom;
  }

  focus() {
    this.view.focus();
  }

  get hasFocus(): boolean {
    return this.view.hasFocus;
  }

  destroy() {
    this.flush();
    this.view.destroy();
  }
}
