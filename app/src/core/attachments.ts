/**
 * Paste and drop images into a body (docs/04-ux-and-interaction.md §2).
 *
 * The body never carries bytes. It carries `![](attachment:<sha256>)`, and the
 * bytes live in the `blob` table under that hash — which is what makes the same
 * screenshot pasted into three todos one stored copy, and what lets Phase 2's
 * blob channel fetch by name with no coordination.
 *
 * Everything here is transport: hashing, storage and addressing are the engine's.
 */

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** How an image reference is written into a body. */
export const ATTACHMENT_PREFIX = "attachment:";

export interface AttachmentSink {
  /** Store bytes, get back the hash the body should reference. */
  put(mime: string, bytes: Uint8Array): Promise<string>;
  /** Surface a failure — the editor has nowhere sensible to put one. */
  onError(message: string): void;
}

/** Images only. A pasted spreadsheet is text, and should paste as text. */
function imageFiles(items: DataTransfer | null): File[] {
  if (!items) return [];
  return [...items.files].filter((f) => f.type.startsWith("image/"));
}

/**
 * Insert a placeholder immediately and swap it for the real reference once the
 * bytes are stored.
 *
 * Writing nothing until the hash comes back would leave the caret sitting in an
 * apparently unresponsive editor; a large paste is not instant, and capture is
 * the flow this app is least willing to make people wait in.
 */
async function attach(view: EditorView, file: File, sink: AttachmentSink) {
  const token = `![](uploading ${file.name}…)`;
  const from = view.state.selection.main.from;
  view.dispatch({
    changes: { from, to: view.state.selection.main.to, insert: token },
    selection: { anchor: from + token.length },
  });

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sink.put(file.type, bytes);
    const replacement = `![](${ATTACHMENT_PREFIX}${hash})`;

    // Find the placeholder again rather than trusting the offset: the caret has
    // been live the whole time, and typing during the write would have moved it.
    const text = view.state.doc.toString();
    const at = text.indexOf(token);
    if (at === -1) return;
    view.dispatch({ changes: { from: at, to: at + token.length, insert: replacement } });
  } catch (e) {
    const text = view.state.doc.toString();
    const at = text.indexOf(token);
    if (at !== -1) view.dispatch({ changes: { from: at, to: at + token.length, insert: "" } });
    sink.onError(e instanceof Error ? e.message : String(e));
  }
}

export function attachments(sink: AttachmentSink): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = imageFiles(event.clipboardData);
      if (files.length === 0) return false;
      event.preventDefault();
      for (const file of files) void attach(view, file, sink);
      return true;
    },
    drop(event, view) {
      const files = imageFiles(event.dataTransfer);
      if (files.length === 0) return false;
      event.preventDefault();
      // Drop where the pointer is, not where the caret was.
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos !== null) view.dispatch({ selection: { anchor: pos } });
      for (const file of files) void attach(view, file, sink);
      return true;
    },
  });
}
