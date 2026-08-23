/**
 * Render `![](attachment:<hash>)` as the image itself.
 *
 * A CodeMirror widget decoration, so the document still holds the plaintext
 * markdown — the same rule the rest of live preview follows, and the reason the
 * EOD report can stay a near-free concatenation of bodies.
 *
 * Bytes are fetched lazily and cached per hash. A body with the same screenshot
 * in it twice fetches once, and re-rendering the editor (which happens on every
 * keystroke) never re-fetches at all.
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
import { ATTACHMENT_PREFIX } from "./attachments";

/** `![alt](attachment:<64 hex chars>)` anywhere on a line. */
const IMAGE = /!\[([^\]]*)\]\(attachment:([0-9a-f]{64})\)/g;

export interface AttachmentSource {
  /** Resolve a hash to something an `<img src>` accepts, or null if absent. */
  url(hash: string): Promise<string | null>;
}

/**
 * Resolved image URLs, shared across every editor instance.
 *
 * Module-level rather than per-plugin because the roving list editor and the
 * detail editor render the same attachments, and a per-instance cache would
 * decode the same base64 twice.
 */
const urls = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

function resolve(hash: string, source: AttachmentSource, onReady: () => void): string | null {
  if (urls.has(hash)) return urls.get(hash) ?? null;
  if (!inFlight.has(hash)) {
    inFlight.set(
      hash,
      source
        .url(hash)
        .catch(() => null)
        .then((url) => {
          urls.set(hash, url);
          inFlight.delete(hash);
          // The widget was built before the bytes arrived, so ask for a rebuild.
          onReady();
          return url;
        }),
    );
  }
  return null;
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly hash: string,
    private readonly alt: string,
    private readonly url: string | null,
  ) {
    super();
  }

  /**
   * CodeMirror reuses a widget's DOM when `eq` says nothing changed. Comparing
   * the URL too means the placeholder is replaced once the bytes land, rather
   * than the pending state sticking until the next edit.
   */
  eq(other: ImageWidget): boolean {
    return other.hash === this.hash && other.alt === this.alt && other.url === this.url;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-image";

    if (!this.url) {
      // The bytes are not here. In Phase 2 that will also mean "not downloaded
      // yet", so this degrades rather than showing a broken-image glyph.
      wrap.textContent = this.alt || "attachment";
      wrap.classList.add("cm-md-image-pending");
      return wrap;
    }

    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    img.loading = "lazy";
    wrap.appendChild(img);
    return wrap;
  }

  /** Clicks belong to the image, not to caret placement. */
  ignoreEvent(): boolean {
    return false;
  }
}

function build(view: EditorView, source: AttachmentSource, onReady: () => void): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const match of text.matchAll(IMAGE)) {
      const start = from + (match.index ?? 0);
      const end = start + match[0].length;
      // Raw only while the caret is *inside* the reference, not merely touching
      // it. Adjacency would mean an image at the end of a body never renders at
      // all, because `load()` parks the caret at the end of the document — so
      // opening any todo that ends with a screenshot would show the markdown.
      if (cursor.from > start && cursor.to < end) continue;

      const hash = match[2]!;
      ranges.push(
        Decoration.replace({
          widget: new ImageWidget(hash, match[1] ?? "", resolve(hash, source, onReady)),
        }).range(start, end),
      );
    }
  }
  return Decoration.set(ranges, true);
}

const imageTheme = EditorView.theme({
  ".cm-md-image img": {
    display: "block",
    maxWidth: "100%",
    maxHeight: "22rem",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    margin: "0.35em 0",
  },
  ".cm-md-image-pending": {
    display: "inline-block",
    padding: "0.1em 0.45em",
    borderRadius: "var(--radius-sm)",
    border: "1px dashed var(--border)",
    color: "var(--muted-foreground)",
    fontSize: "0.8125em",
  },
});

export function imageWidgets(source: AttachmentSource): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = build(view, source, () => this.refresh(view));
        }

        update(update: ViewUpdate) {
          if (update.docChanged || update.selectionSet || update.viewportChanged) {
            this.decorations = build(update.view, source, () => this.refresh(update.view));
          }
        }

        /** Rebuild once bytes arrive, outside the update cycle CodeMirror forbids. */
        private refresh(view: EditorView) {
          queueMicrotask(() => {
            this.decorations = build(view, source, () => {});
            view.dispatch({});
          });
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    imageTheme,
  ];
}

/** Turn stored bytes into a `data:` URL an `<img>` can use. */
export function dataUrl(mime: string, base64: string): string {
  return `data:${mime || "application/octet-stream"};base64,${base64}`;
}

export { ATTACHMENT_PREFIX };
