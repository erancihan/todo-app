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

import {
  DAY_SUGGESTIONS,
  parseDayToken,
  parseRepeatToken,
  REPEAT_SUGGESTIONS,
} from "./date-token";

export interface TokenSources {
  /** Existing tag names, for suggestions. */
  tags(): string[];
  /** Existing collection names. */
  collections(): string[];
  /** Apply a tag to whatever node this editor is editing. */
  applyTag(name: string): void;
  /** File that node into a collection, creating it if it is new. */
  applyCollection(name: string): void;
  /** Schedule that node for a civil day (`YYYY-MM-DD`). */
  applySchedule(day: string): void;
  /** Adopt a repeat rule (canonical text) and plan its first occurrence. */
  applyRepeat(rule: string): void;
}

/**
 * Tags cannot contain whitespace; collection names can ("Client X"), so `@`
 * matches spaces too — but only up to two words, or every `@` would swallow the
 * rest of the line and the menu would never close.
 *
 * The date token allows up to three words ("august 30 2026") of word characters
 * and hyphens ("2026-08-30") — everything the bounded grammar can produce.
 */
const TAG_TOKEN = /#([\w-]*)$/;
const COLLECTION_TOKEN = /@([\w-]*(?: [\w-]+)?)$/;
const DATE_TOKEN = /!([\w-]*(?: [\w-]+){0,2})$/;

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

/**
 * The `!` menu. Unlike `#`/`@` there is no list of existing values to draw on —
 * the options are the grammar's own suggestions, each previewed with the day it
 * resolves to, plus whatever the user typed when it parses. Nothing that fails
 * to parse is offered, so the menu can never schedule a guess.
 */
function buildDates(
  from: number,
  to: number,
  typed: string,
  applyDay: (day: string) => void,
  applyRepeat: (rule: string) => void,
): CompletionResult | null {
  const now = new Date();
  const query = typed.toLowerCase().trim();

  const commit = (run: () => void) => (view: EditorView) => {
    view.dispatch({ changes: { from, to, insert: "" } });
    run();
  };

  const options: Completion[] = [];
  for (const name of DAY_SUGGESTIONS) {
    if (query && !name.startsWith(query)) continue;
    const parsed = parseDayToken(name, now);
    if (!parsed) continue;
    options.push({
      label: `!${name}`,
      detail: parsed.label,
      type: "constant",
      apply: commit(() => applyDay(parsed.day)),
    });
  }
  for (const name of REPEAT_SUGGESTIONS) {
    if (query && !name.startsWith(query)) continue;
    const parsed = parseRepeatToken(name, now);
    if (!parsed) continue;
    options.push({
      label: `!${name}`,
      detail: `repeats · from ${parsed.label}`,
      type: "constant",
      apply: commit(() => applyRepeat(parsed.rule)),
    });
  }

  // Direct input that is not a suggestion prefix — "!aug 30", "!in 4 days",
  // "!every 2 weeks" — still parses; offer it first, previewed with what it
  // means. A repeat rule and a day never collide: no day form starts "every".
  if (query && !DAY_SUGGESTIONS.some((s) => s === query)) {
    const day = parseDayToken(query, now);
    if (day) {
      options.unshift({
        label: `!${query}`,
        detail: day.label,
        type: "constant",
        apply: commit(() => applyDay(day.day)),
      });
    } else if (!REPEAT_SUGGESTIONS.some((s) => s === query)) {
      const repeat = parseRepeatToken(query, now);
      if (repeat) {
        options.unshift({
          label: `!${repeat.rule}`,
          detail: `repeats · from ${repeat.label}`,
          type: "constant",
          apply: commit(() => applyRepeat(repeat.rule)),
        });
      }
    }
  }

  return options.length ? { from, to, options, filter: false } : null;
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

    const date = context.matchBefore(DATE_TOKEN);
    if (date) {
      // `!` is ordinary punctuation at the end of a word — "ship it!" must not
      // pop a scheduling menu — so the token only counts at the start of one.
      // The guard includes `!` itself, or "ship it!!" would match on the second.
      if (date.from > 0) {
        const before = context.state.sliceDoc(date.from - 1, date.from);
        if (/[\w!]/.test(before)) return null;
      }
      const typed = date.text.slice(1);
      // The regex admits a leading space so "!next week" works, but prose after
      // a bang — "So close! tomorrow we ship" — is not a token.
      if (typed.startsWith(" ")) return null;
      return buildDates(date.from, date.to, typed, sources.applySchedule, sources.applyRepeat);
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
