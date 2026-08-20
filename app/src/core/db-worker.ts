/**
 * The browser engine host.
 *
 * Runs in a Worker for a load-bearing reason, not for tidiness: OPFS's
 * `FileSystemSyncAccessHandle` is a worker-first API, and the *synchronous*
 * SQLite access it enables is what lets `daybook-core` keep ordinary control flow
 * instead of every engine method becoming async. Rust calls JS synchronously here;
 * only the main-thread boundary is async.
 *
 * This file is a driver and nothing else. It owns no schema, makes no decisions,
 * and does not know what a node is — it hands SQL to SQLite and rows back to Rust.
 * Everything that thinks lives in `crates/core/src/engine.rs`, shared verbatim
 * with the Tauri build.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import initWasm, { DaybookEngine } from "./wasm/daybook_core.js";

/** Matches the Tauri shell's account, so both hosts partition identically. */
const ACCOUNT_ID = "local";
const DB_NAME = "/daybook-local.sqlite3";
const DEVICE_KEY = "daybook.device-id";

interface Request {
  id: number;
  method: string;
  args: unknown[];
}

let engine: DaybookEngine | null = null;
let bootError: string | null = null;

/**
 * A device identity that survives reloads. Regenerating it per session would make
 * every page load look like a new replica, breaking HLC tie-breaks and making
 * order-key jitter useless.
 */
function deviceId(): string {
  try {
    const existing = self.localStorage?.getItem(DEVICE_KEY);
    if (existing) return existing;
  } catch {
    // localStorage is unavailable in some worker contexts; fall through.
  }
  const fresh = `web-${crypto.randomUUID()}`;
  try {
    self.localStorage?.setItem(DEVICE_KEY, fresh);
  } catch {
    /* best effort — a fresh id per session still works, just less well */
  }
  return fresh;
}

/**
 * Open an OPFS-backed database.
 *
 * Prefers the SAH-pool VFS: it needs no COOP/COEP headers, so the deployed PWA
 * does not have to serve cross-origin-isolated pages just to have a local
 * database. Falls back to the classic `opfs` VFS, which does require them.
 */
async function openDatabase(sqlite3: any): Promise<{ db: any; vfs: string }> {
  const problems: string[] = [];

  if (typeof sqlite3.installOpfsSAHPoolVfs === "function") {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "daybook-pool" });
      return { db: new pool.OpfsSAHPoolDb(DB_NAME), vfs: "opfs-sahpool" };
    } catch (e) {
      problems.push(`opfs-sahpool: ${message(e)}`);
    }
  }

  if (sqlite3.oo1?.OpfsDb) {
    try {
      return { db: new sqlite3.oo1.OpfsDb(DB_NAME), vfs: "opfs" };
    } catch (e) {
      problems.push(`opfs: ${message(e)}`);
    }
  }

  // Deliberately not falling back to an in-memory database. Silently running
  // without persistence would look like it worked and lose the user's data on
  // reload — a loud failure is the honest outcome.
  //
  // The most likely cause in practice is a second tab: the SAH-pool VFS takes
  // exclusive sync access handles, so only one tab per origin can hold the
  // database. Say so, because the raw DOMException does not.
  const multiTab = problems.some((p) => p.includes("NoModificationAllowedError"));
  throw new Error(
    multiTab
      ? "Daybook is already open in another tab. The local database can only be " +
        "held by one tab at a time — close the other one and reload."
      : `no OPFS-backed VFS available (${problems.join(" | ")})`,
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function boot(): Promise<void> {
  await initWasm();
  const sqlite3 = await sqlite3InitModule();
  const { db, vfs } = await openDatabase(sqlite3);
  console.info(`[daybook] SQLite ${sqlite3.version.libVersion} on ${vfs}`);

  // The two synchronous callbacks `daybook-core` drives SQLite through.
  const execute = (sql: string, params: unknown[]): number => {
    db.exec({ sql, bind: params.length ? params : undefined });
    // `changes()` is per-connection and post-statement; the engine only uses it
    // for affected-row counts, never for control flow.
    return db.changes();
  };

  const query = (sql: string, params: unknown[]): unknown[][] => {
    const rows: unknown[][] = [];
    db.exec({
      sql,
      bind: params.length ? params : undefined,
      rowMode: "array",
      callback: (row: unknown[]) => void rows.push(row),
    });
    return rows;
  };

  engine = new DaybookEngine(execute, query, ACCOUNT_ID, deviceId());
}

const ready = boot().catch((e) => {
  bootError = message(e);
  console.error("[daybook] engine failed to start:", e);
});

self.addEventListener("message", async (ev: MessageEvent<Request>) => {
  const { id, method, args } = ev.data;
  await ready;

  if (!engine) {
    self.postMessage({ id, ok: false, error: bootError ?? "engine unavailable" });
    return;
  }

  try {
    const fn = (engine as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new Error(`unknown engine method: ${method}`);
    }
    const result = (fn as (...a: unknown[]) => unknown).apply(engine, args);
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    // Errors from Rust arrive as strings via `JsValue::from_str`.
    self.postMessage({ id, ok: false, error: message(e) });
  }
});
