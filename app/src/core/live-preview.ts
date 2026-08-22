/**
 * Obsidian-style inline live preview for the markdown body
 * (docs/04-ux-and-interaction.md §2).
 *
 * The rule, and the reason it feels right: **the line your caret is on shows its
 * raw markdown; every other line shows the rendered result.** So you always see
 * the syntax you are currently editing and never the syntax you are not. The
 * document itself is untouched — this is purely decoration over literal markdown,
 * which is what keeps the plaintext model, the CRDT merge, and the
 * report-as-concatenation all working.
 *
 * Implemented with CodeMirror decorations rather than a second rendered pane:
 * a preview pane would mean two things to keep in sync and would break the
 * "never feel you left a text editor" promise.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/**
 * Syntax-tree node names whose text is pure markup — the characters that should
 * vanish once the caret leaves the line.
 *
 * `HeaderMark` covers `#`, `EmphasisMark` covers `*`/`_`, `CodeMark` the
 * backticks, `QuoteMark` the `>`, `LinkMark` the brackets. `ListMark` is
 * deliberately absent: a bullet is meaningful *rendered* content, so it gets
 * replaced with a real bullet glyph rather than hidden.
 */
const HIDDEN_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrongEmphasisMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
  "StrikethroughMark",
]);

/** Node names that get a style but keep their text. */
const STYLED: Record<string, string> = {
  ATXHeading1: "cm-md-h1",
  ATXHeading2: "cm-md-h2",
  ATXHeading3: "cm-md-h3",
  ATXHeading4: "cm-md-h4",
  ATXHeading5: "cm-md-h5",
  ATXHeading6: "cm-md-h6",
  Emphasis: "cm-md-em",
  StrongEmphasis: "cm-md-strong",
  InlineCode: "cm-md-code",
  FencedCode: "cm-md-fence",
  CodeBlock: "cm-md-fence",
  Strikethrough: "cm-md-strike",
  Blockquote: "cm-md-quote",
  URL: "cm-md-url",
};

const hidden = Decoration.replace({});

/** Lines the caret (or any selection) touches — these stay raw. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let line = from; line <= to; line++) lines.add(line);
  }
  return lines;
}

function buildDecorations(view: EditorView): DecorationSet {
  // Collected then sorted, rather than fed to a RangeSetBuilder. The syntax tree
  // yields parents before children, so a heading and the `#` inside it arrive at
  // the *same* offset with different decoration sides — which a builder rejects
  // as unsorted. `Decoration.set(..., true)` sorts them properly.
  const ranges: Range<Decoration>[] = [];
  const active = activeLines(view.state);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const style = STYLED[node.name];
        if (style) {
          ranges.push(Decoration.mark({ class: style }).range(node.from, node.to));
          return;
        }

        if (!HIDDEN_MARKS.has(node.name)) return;

        // Never hide markup on the line being edited — that is the whole point.
        const line = view.state.doc.lineAt(node.from).number;
        if (active.has(line)) return;

        // A heading's `#` is followed by a space that is also markup; swallow it
        // too, or every rendered heading starts with a stray indent.
        let end = node.to;
        if (node.name === "HeaderMark" || node.name === "QuoteMark") {
          const after = view.state.doc.sliceString(node.to, node.to + 1);
          if (after === " ") end = node.to + 1;
        }
        if (end > node.from) ranges.push(hidden.range(node.from, end));
      },
    });
  }

  return Decoration.set(ranges, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      // Selection changes matter as much as document changes here: moving the
      // caret onto a line is what un-hides its syntax.
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * Typography for the rendered state.
 *
 * Sizes are restrained on purpose: this is a dense capture surface, not a
 * document editor, and an `h1` at 2rem inside a list row would wreck the rhythm
 * (docs/04 §7.2).
 */
const livePreviewTheme = EditorView.theme({
  ".cm-md-h1": { fontSize: "1.25rem", fontWeight: "590", lineHeight: "1.7rem" },
  ".cm-md-h2": { fontSize: "1.125rem", fontWeight: "560", lineHeight: "1.6rem" },
  ".cm-md-h3": { fontSize: "1rem", fontWeight: "560" },
  ".cm-md-h4": { fontSize: "0.9375rem", fontWeight: "560" },
  ".cm-md-h5": { fontSize: "0.9375rem", fontWeight: "510" },
  ".cm-md-h6": { fontSize: "0.9375rem", fontWeight: "510", opacity: "0.8" },
  ".cm-md-strong": { fontWeight: "620" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through", opacity: "0.7" },
  ".cm-md-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    background: "var(--muted)",
    borderRadius: "3px",
    padding: "0.05em 0.3em",
  },
  // Fences stay monospace even though bodies are prose (docs/04 §8, Screen 2).
  ".cm-md-fence": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    background: "var(--muted)",
    borderRadius: "var(--radius-sm)",
    display: "inline-block",
    width: "100%",
    padding: "0.2em 0.5em",
  },
  ".cm-md-quote": {
    color: "var(--muted-foreground)",
    borderLeft: "2px solid var(--border)",
    paddingLeft: "0.6em",
  },
  ".cm-md-url": { color: "var(--primary)", textDecoration: "underline" },
});

export function livePreview(): Extension {
  return [livePreviewPlugin, livePreviewTheme];
}
