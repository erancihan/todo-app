/**
 * Clickable links, rendered as compact reference chips.
 *
 * Daybook is a todo tracker, not an issue tracker — when a task concerns a
 * ticket, the right shape is a **pointer**: a short chip that names the thing
 * and opens it where it lives. So `https://github.com/acme/app/issues/123`
 * renders as `acme/app#123`, a Jira URL as its key, a Notion URL as its page
 * name — and clicking any of them opens the system browser.
 *
 * Everything is local pattern-matching on the URL. No network, no unfurling, no
 * tokens to configure: the label is derived from the URL's own structure, which
 * is why only services with structured URLs get special labels and everything
 * else falls back to its hostname.
 */

import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from "@codemirror/view";

/** `[label](https://…)` or a bare URL. Bare URLs stop before closing brackets
 *  and trailing punctuation so prose like "(see https://x.dev)." stays intact. */
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /(?<![([])https?:\/\/[^\s<>"')\]]+/g;

export interface LinkRef {
  label: string;
  /** A service glyph shown before the label, or "" for a plain link. */
  glyph: string;
  url: string;
}

/** Strip `.,;:!?` that grammar, not the URL, put at the end. */
function trimPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

/**
 * Derive a short label from a URL's structure.
 *
 * Only hosts whose URLs *carry* an identity get a special form; guessing at
 * anything else would produce confidently wrong labels.
 */
export function recognize(rawUrl: string): LinkRef {
  const url = trimPunctuation(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { label: url, glyph: "", url };
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const parts = parsed.pathname.split("/").filter(Boolean);

  // github.com/owner/repo/issues/123 → owner/repo#123 (pulls too)
  if (host === "github.com" && parts.length >= 4 && ["issues", "pull"].includes(parts[2]!)) {
    return { label: `${parts[0]}/${parts[1]}#${parts[3]}`, glyph: "", url };
  }
  if (host === "github.com" && parts.length >= 2) {
    return { label: `${parts[0]}/${parts[1]}`, glyph: "", url };
  }

  // gitlab.com/group[/sub]/repo/-/issues/45 → repo#45 · merge_requests → repo!45
  if (host === "gitlab.com") {
    const dash = parts.indexOf("-");
    if (dash > 0 && parts.length > dash + 2) {
      const kind = parts[dash + 1];
      const n = parts[dash + 2];
      const repo = parts[dash - 1];
      if (kind === "issues") return { label: `${repo}#${n}`, glyph: "", url };
      if (kind === "merge_requests") return { label: `${repo}!${n}`, glyph: "", url };
    }
  }

  // acme.atlassian.net/browse/PROJ-123 → PROJ-123
  if (host.endsWith(".atlassian.net") && parts[0] === "browse" && parts[1]) {
    return { label: parts[1], glyph: "", url };
  }

  // linear.app/team/issue/ENG-42[/slug] → ENG-42
  if (host === "linear.app" && parts[1] === "issue" && parts[2]) {
    return { label: parts[2], glyph: "", url };
  }

  // notion.so/[workspace/]Page-Title-8a2f… → Page Title
  if (host === "notion.so" || host.endsWith(".notion.site")) {
    const last = parts[parts.length - 1] ?? "";
    const words = last
      .replace(/-?[0-9a-f]{32}$/, "")
      .split("-")
      .filter(Boolean);
    if (words.length > 0) return { label: words.join(" "), glyph: "", url };
  }

  // Anything else: the hostname is honest and short.
  return { label: host, glyph: "", url };
}

/**
 * Open a link outside the app.
 *
 * Injected rather than imported so this module stays free of the engine port:
 * the Tauri shell opens through its `open_url` command, the browser through
 * `window.open`, and a test through a spy.
 */
export type OpenExternal = (url: string) => void;

class LinkWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly url: string,
    private readonly open: OpenExternal,
  ) {
    super();
  }

  eq(other: LinkWidget): boolean {
    return other.label === this.label && other.url === this.url;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("a");
    chip.className = "cm-link-chip";
    chip.textContent = this.label;
    chip.href = this.url;
    chip.title = this.url;
    // The click must not become a caret placement or, in Tauri, a WebView
    // navigation that replaces the whole app with the linked page.
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.open(this.url);
    });
    return chip;
  }

  ignoreEvent(event: Event): boolean {
    // Let clicks through to our handler; everything else is the editor's.
    return event.type === "click" || event.type === "mousedown";
  }
}

function build(view: EditorView, open: OpenExternal): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main;
  /** Spans already claimed by a markdown link, so the bare-URL pass skips them. */
  const claimed: Array<[number, number]> = [];

  const add = (start: number, end: number, label: string, url: string) => {
    // Editing the link shows the raw text — the same caret rule every other
    // rendered token follows.
    if (cursor.from > start && cursor.to < end) return;
    // Never render a chip for an attachment reference; the image widget owns it.
    if (url.startsWith("attachment:")) return;
    ranges.push(
      Decoration.replace({ widget: new LinkWidget(label, url, open) }).range(start, end),
    );
  };

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);

    for (const match of text.matchAll(MD_LINK)) {
      const start = from + (match.index ?? 0);
      const end = start + match[0].length;
      claimed.push([start, end]);
      // An explicit label wins over recognition — the author already named it.
      add(start, end, match[1]!, trimPunctuation(match[2]!));
    }

    for (const match of text.matchAll(BARE_URL)) {
      const start = from + (match.index ?? 0);
      const url = trimPunctuation(match[0]);
      const end = start + url.length;
      if (claimed.some(([a, b]) => start >= a && start < b)) continue;
      const ref = recognize(url);
      add(start, end, ref.label, url);
    }
  }
  return Decoration.set(ranges, true);
}

const chipTheme = EditorView.theme({
  ".cm-link-chip": {
    display: "inline-block",
    padding: "0 0.4em",
    margin: "0 0.1em",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--muted)",
    color: "var(--primary)",
    textDecoration: "none",
    fontSize: "0.875em",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  ".cm-link-chip:hover": {
    borderColor: "var(--primary)",
  },
});

export function linkChips(open: OpenExternal): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view, open);
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.selectionSet || update.viewportChanged) {
            this.decorations = build(update.view, open);
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    chipTheme,
  ];
}
