/**
 * Host affordances that are not the engine.
 *
 * The engine port carries data; this carries the few things the UI needs from
 * the *shell* itself. Kept apart so modules like `link-chips` can open a URL
 * without knowing which host they are in — or importing the engine to find out.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./engine-port";

/** Open a URL in the system browser, whichever host this is. */
export function openExternal(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  if (isTauri()) {
    // The WebView must never navigate to an external site itself; the shell
    // opens the OS browser instead.
    void invoke("open_url", { url }).catch(() => {});
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
