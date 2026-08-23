/**
 * Inline `#tag` and `@collection` autocomplete (docs/04-ux-and-interaction.md §2).
 *
 * The doc's requirement is that "the two axes can be set without leaving the
 * keyboard", which is a statement about *structure*, not about text. So accepting
 * a completion **removes the token from the body** and applies the tag or
 * collection to the node instead.
 *
 * That is the part worth being deliberate about. Leaving `#urgent` in the prose
 * and also showing a chip would say the same thing twice — once as content the
 * report would render literally, once as the relation the data model actually
 * holds. The token is a command you type, the way `@` works in Slack: it turns
 * into structure and gets out of the way.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface TokenSources {
  /** Existing tag names, for suggestions. */
  tags(): string[];
  /** Existing collection names. */
  collections(): string[];
  /** Apply a tag to whatever node this editor is editing. */
  applyTag(name: string): void;
  /** File that node into a collection, creating it if it is new. */
  applyCollection(name: string): void;
}

/**
 * Tags cannot contain whitespace; collection names can ("Client X"), so `@`
 * matches spaces too — but only up to two words, or every `@` would swallow the
 * rest of the line and the menu would never close.
 */
const TAG_TOKEN = /#([\w-]*)$/;
const COLLECTION_TOKEN = /@([\w-]*(?: [\w-]+)?)$/;

function build(
  from: number,
  to: number,
  typed: string,
  existing: string[],
  kind: "tag" | "collection",
  apply: (name: string) => void,
): CompletionResult {
  const query = typed.toLowerCase();
  const matches = existing.filter((name) => name.toLowerCase().includes(query));

  const commit = (name: string) => (view: EditorView) => {
    // Delete the token first, then apply. Doing it the other way round would
    // re-render the row from the engine and move the ranges out from under this
    // change.
    view.dispatch({ changes: { from, to, insert: "" } });
    apply(name);
  };

  const options: Completion[] = matches.map((name) => ({
    label: `${kind === "tag" ? "#" : "@"}${name}`,
    type: kind === "tag" ? "keyword" : "namespace",
    apply: commit(name),
  }));

  // Offer the new name too, unless it already exists exactly. Capture is the
  // point of this app; being told a tag does not exist yet is friction.
  const trimmed = typed.trim();
  if (trimmed && !existing.some((name) => name.toLowerCase() === trimmed.toLowerCase())) {
    options.push({
      label: `${kind === "tag" ? "#" : "@"}${trimmed}`,
      detail: `new ${kind}`,
      type: "text",
      boost: -1,
      apply: commit(trimmed),
    });
  }

  return { from, to, options, filter: false };
}

function source(sources: TokenSources) {
  return (context: CompletionContext): CompletionResult | null => {
    const tag = context.matchBefore(TAG_TOKEN);
    if (tag) {
      // An explicit request on a bare `#` should still list what exists; typing
      // one mid-word (`C#`) should not pop a menu.
      if (tag.from > 0) {
        const before = context.state.sliceDoc(tag.from - 1, tag.from);
        if (/[\w]/.test(before)) return null;
      }
      if (tag.text.length === 1 && !context.explicit && sources.tags().length === 0) return null;
      return build(tag.from, tag.to, tag.text.slice(1), sources.tags(), "tag", sources.applyTag);
    }

    const collection = context.matchBefore(COLLECTION_TOKEN);
    if (collection) {
      if (collection.from > 0) {
        const before = context.state.sliceDoc(collection.from - 1, collection.from);
        if (/[\w]/.test(before)) return null;
      }
      return build(
        collection.from,
        collection.to,
        collection.text.slice(1),
        sources.collections(),
        "collection",
        sources.applyCollection,
      );
    }

    return null;
  };
}

/**
 * The completion menu, in the app's own palette.
 *
 * CodeMirror ships a serviceable light-mode tooltip; dropped into a dark,
 * token-driven design system it reads as a piece of another program. These rules
 * point it at the same variables everything else uses, so it follows the theme
 * toggle for free.
 */
const completionTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--card)",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.28)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-sans)",
    fontSize: "0.8125rem",
    maxHeight: "14rem",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    padding: "4px 10px",
    color: "var(--foreground)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--muted)",
    color: "var(--foreground)",
  },
  ".cm-completionDetail": {
    marginLeft: "0.5em",
    color: "var(--muted-foreground)",
    fontStyle: "normal",
    fontSize: "0.6875rem",
  },
});

export function tokenComplete(sources: TokenSources): Extension {
  return [completionTheme, autocompletion({
    override: [source(sources)],
    // The app owns Escape and Enter; letting the completion plugin add its own
    // keymap on top would give Escape two meanings inside the editor.
    defaultKeymap: true,
    icons: false,
    activateOnTyping: true,
  })];
}
