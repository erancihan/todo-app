/**
 * Transient confirmations (docs/04-ux-and-interaction.md §7.7, "Toast").
 *
 * A plain-TS module with its own subscriber list rather than Alpine state,
 * because toasts are fired from places that have no component in scope — the
 * clipboard callback, an engine error handler — and threading a component
 * reference to each of them would be worse than a module-level channel.
 *
 * Deliberately not a queue: a second toast replaces the first. Stacking them
 * turns a confirmation into a wall, and the only thing a toast is for is the
 * reassurance that the thing you just asked for happened.
 */

export type ToastKind = "info" | "error";

export interface ToastMessage {
  /** Bumped on every fire so the view can restart its timer for a repeat. */
  id: number;
  text: string;
  kind: ToastKind;
}

type Listener = (message: ToastMessage | null) => void;

const listeners = new Set<Listener>();
let current: ToastMessage | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let counter = 0;

/** How long a toast stays up. Errors linger — they are worth reading twice. */
const DURATIONS: Record<ToastKind, number> = { info: 2400, error: 5000 };

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

export function toast(text: string, kind: ToastKind = "info"): void {
  counter += 1;
  current = { id: counter, text, kind };
  for (const listener of listeners) listener(current);

  if (timer) clearTimeout(timer);
  timer = setTimeout(dismissToast, DURATIONS[kind]);
}

export function dismissToast(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!current) return;
  current = null;
  for (const listener of listeners) listener(null);
}
