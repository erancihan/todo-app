/**
 * Spike 2 worker — where the whole probe actually runs (throwaway).
 *
 * SQLite lives in a Worker deliberately, not just for convenience: OPFS's
 * `FileSystemSyncAccessHandle` is a worker-first API, and keeping the engine off
 * the main thread is the shape the shipped browser build wants anyway.
 *
 * Division of labour, mirroring the production design:
 *   Rust/WASM — the engine: Y.Text merge, UUIDv7, fractional order keys, SCHEMA_SQL.
 *   JS        — the SQLite driver only. It executes SQL; it decides nothing.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

interface RustProbe {
  name: string;
  passed: boolean;
  detail: string;
}

const DB_NAME = "/daybook-spike.sqlite3";
const DEVICE_ID = "0199c0de-spike-worker-0001";

const checks: Check[] = [];
function check(name: string, passed: boolean, detail = "") {
  checks.push({ name, passed, detail });
}
function adopt(p: RustProbe) {
  checks.push({ name: p.name, passed: p.passed, detail: p.detail });
}

/**
 * Load the wasm-bindgen output. Kept outside Vite's module graph so a missing
 * `pkg/` reports a clear "run build:wasm" instead of failing the whole bundle.
 */
async function loadWasm() {
  const url = new URL("./pkg/daybook_wasm_spike.js", import.meta.url).href;
  const mod = await import(/* @vite-ignore */ url);
  await mod.default({
    module_or_path: new URL("./pkg/daybook_wasm_spike_bg.wasm", import.meta.url),
  });
  return mod;
}

/**
 * Open a database backed by real OPFS storage.
 *
 * Prefers the SAH-pool VFS: it needs no COOP/COEP headers, which matters because
 * the shipped PWA would otherwise have to serve cross-origin-isolated pages just
 * to have a local database. Falls back to the classic `opfs` VFS.
 */
async function openOpfsDb(sqlite3: any): Promise<{ db: any; vfs: string }> {
  const errors: string[] = [];

  if (typeof sqlite3.installOpfsSAHPoolVfs === "function") {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "daybook-spike-pool" });
      return { db: new pool.OpfsSAHPoolDb(DB_NAME), vfs: "opfs-sahpool" };
    } catch (e) {
      errors.push(`opfs-sahpool: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    errors.push("opfs-sahpool: installOpfsSAHPoolVfs unavailable");
  }

  if (sqlite3.oo1?.OpfsDb) {
    try {
      return { db: new sqlite3.oo1.OpfsDb(DB_NAME), vfs: "opfs" };
    } catch (e) {
      errors.push(`opfs: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    errors.push("opfs: oo1.OpfsDb unavailable (needs COOP/COEP + SharedArrayBuffer)");
  }

  throw new Error(errors.join(" | "));
}

async function run(): Promise<{ checks: Check[]; env: string }> {
  const wasm = await loadWasm();

  // --- 1. the wasm module is live -----------------------------------------
  const runtime = wasm.core_runtime();
  const echo = wasm.core_echo("hello from the browser");
  check(
    "daybook-core runs on wasm32",
    runtime === "wasm/browser" && echo.includes("hello from the browser"),
    `runtime=${runtime}\n${echo}`,
  );

  // --- 2. the body CRDT converges, inside WASM -----------------------------
  adopt(wasm.core_body_probe() as RustProbe);

  // --- 3. real OPFS-backed SQLite ------------------------------------------
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  const { db, vfs } = await openOpfsDb(sqlite3);
  check(
    "SQLite opened on an OPFS-backed VFS",
    vfs === "opfs-sahpool" || vfs === "opfs",
    `vfs = ${vfs} (persistent origin storage, not in-memory)`,
  );

  const env = [
    `sqlite  ${sqlite3.version.libVersion}`,
    `vfs     ${vfs}`,
    `wasm    ${runtime}`,
    `ua      ${navigator.userAgent}`,
  ].join("\n");

  try {
    // Start from a clean table each run so counts are deterministic; the
    // *database file* still persists in OPFS, which is what §5 checks.
    db.exec("DROP TABLE IF EXISTS node; DROP TABLE IF EXISTS event;");

    // --- 4. the schema comes from Rust, verbatim --------------------------
    const schema: string = wasm.schema_sql();
    db.exec(schema);
    const tables: string[] = [];
    db.exec({
      sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      rowMode: "array",
      callback: (row: unknown[]) => void tables.push(String(row[0])),
    });
    check(
      "Rust SCHEMA_SQL applies under sqlite-wasm",
      tables.includes("node") && tables.includes("event"),
      `the same constant rusqlite runs natively; tables = [${tables.join(", ")}]`,
    );

    // --- 5. write/read round-trip ------------------------------------------
    const write = wasm.build_node_write(DEVICE_ID) as {
      id: string;
      title: string;
      body_md: string;
      order_key: string;
      hlc: string;
    };

    db.exec({
      sql: `INSERT INTO node (account_id, id, title, body_md, order_key, hlc)
            VALUES (?, ?, ?, ?, ?, ?)`,
      bind: ["acct-local", write.id, write.title, write.body_md, write.order_key, write.hlc],
    });

    const readRows: string[] = [];
    db.exec({
      sql: "SELECT body_md FROM node WHERE account_id = ? AND id = ?",
      bind: ["acct-local", write.id],
      rowMode: "array",
      callback: (row: unknown[]) => void readRows.push(String(row[0])),
    });

    // Rust does the comparison, so the page cannot accidentally assert nothing.
    adopt(
      wasm.verify_round_trip(write.body_md, readRows[0] ?? "", readRows.length) as RustProbe,
    );

    // --- 6. order keys sort in SQLite the way Rust intends -----------------
    const keys: string[] = Array.from(wasm.build_order_keys(DEVICE_ID, 25));
    // Insert in a deliberately wrong order — if SQLite's collation disagreed with
    // the fractional index, this is where it would show.
    const shuffled = [...keys].reverse();
    shuffled.forEach((key, i) => {
      db.exec({
        sql: `INSERT INTO node (account_id, id, title, order_key) VALUES (?, ?, ?, ?)`,
        bind: ["acct-order", `ord-${i}`, `row ${i}`, key],
      });
    });

    const sorted: string[] = [];
    db.exec({
      sql: "SELECT order_key FROM node WHERE account_id = ? ORDER BY order_key",
      bind: ["acct-order"],
      rowMode: "array",
      callback: (row: unknown[]) => void sorted.push(String(row[0])),
    });
    const orderMatches = sorted.length === keys.length && sorted.every((k, i) => k === keys[i]);
    check(
      "Fractional order keys sort identically in SQLite",
      orderMatches,
      orderMatches
        ? `${keys.length} keys inserted reversed, read back in generation order`
        : `mismatch\n  rust: ${keys.slice(0, 4).join(", ")}…\n  sql:  ${sorted.slice(0, 4).join(", ")}…`,
    );

    // --- 7. account partitioning holds through the real driver -------------
    let localCount = 0;
    db.exec({
      sql: "SELECT COUNT(*) FROM node WHERE account_id = ?",
      bind: ["acct-local"],
      rowMode: "array",
      callback: (row: unknown[]) => void (localCount = Number(row[0])),
    });
    check(
      "Store stays account-partitioned",
      localCount === 1,
      `acct-local sees ${localCount} row (acct-order wrote ${keys.length} more)`,
    );

    // --- 8. durability: bytes survive closing and reopening the file -------
    db.close();
    const reopened = await openOpfsDb(sqlite3);
    let survived = 0;
    reopened.db.exec({
      sql: "SELECT COUNT(*) FROM node WHERE account_id = ?",
      bind: ["acct-local"],
      rowMode: "array",
      callback: (row: unknown[]) => void (survived = Number(row[0])),
    });
    reopened.db.close();
    check(
      "Data survives closing and reopening the OPFS database",
      survived === 1,
      `re-opened ${DB_NAME} from origin storage and found ${survived} row — durable, not in-memory`,
    );
  } catch (e) {
    check("probe run completed", false, e instanceof Error ? e.stack ?? e.message : String(e));
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  return { checks, env };
}

self.addEventListener("message", (ev: MessageEvent) => {
  if (ev.data !== "run") return;
  run().then(
    (result) => self.postMessage({ ok: true, ...result }),
    (err: unknown) =>
      self.postMessage({
        ok: false,
        checks: [
          {
            name: "worker bootstrap",
            passed: false,
            detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
          },
        ],
        env: navigator.userAgent,
      }),
  );
});
