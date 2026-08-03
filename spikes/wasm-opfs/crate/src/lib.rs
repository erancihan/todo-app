//! Spike 2 — a slice of `daybook-core`, compiled to wasm32 and called from a
//! browser page (throwaway).
//!
//! What this proves: the **engine-port split is real**, not aspirational. The very
//! same `daybook-core` API that the Tauri shell reaches over IPC
//! (`app/src-tauri/src/lib.rs`) is reachable here as a direct WASM call, and the
//! SQL it produces runs against `sqlite-wasm` + OPFS instead of `rusqlite`.
//!
//! The division of labour is deliberate and mirrors the shipped design:
//!
//! * **Rust/WASM** owns the engine — `Y.Text` merge, HLC, ids, order keys, and the
//!   `SCHEMA_SQL` + statements the projection needs.
//! * **JS** owns the SQLite *driver* only, because `sqlite-wasm` is a JS package
//!   and OPFS is a browser API. It executes SQL; it never decides anything.

use daybook_core::body::{BodyCrdt, YrsBody};
use daybook_core::ids::DeviceId;
use daybook_core::order_key;
use daybook_core::store::SCHEMA_SQL;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize)]
pub struct Probe {
    pub name: String,
    pub passed: bool,
    pub detail: String,
}

fn ok(name: &str, detail: String) -> JsValue {
    serde_wasm_bindgen::to_value(&Probe {
        name: name.into(),
        passed: true,
        detail,
    })
    .unwrap_or(JsValue::NULL)
}

fn fail(name: &str, detail: String) -> JsValue {
    serde_wasm_bindgen::to_value(&Probe {
        name: name.into(),
        passed: false,
        detail,
    })
    .unwrap_or(JsValue::NULL)
}

/// Which port implementation is live — the WASM counterpart of the Tauri
/// `core_runtime` command.
#[wasm_bindgen]
pub fn core_runtime() -> String {
    "wasm/browser".into()
}

/// The string round-trip, identical to the Tauri command of the same name.
#[wasm_bindgen]
pub fn core_echo(input: &str) -> String {
    daybook_core::echo(input)
}

/// The projection DDL, handed to `sqlite-wasm` verbatim. Same constant the native
/// build feeds to `rusqlite` — one schema, two drivers.
#[wasm_bindgen]
pub fn schema_sql() -> String {
    SCHEMA_SQL.to_string()
}

/// Runs the concurrent `Y.Text` merge **inside WASM** and returns the merged body.
/// JS never touches the CRDT.
#[wasm_bindgen]
pub fn core_body_probe() -> JsValue {
    let name = "yrs Y.Text converges (wasm32)";
    let run = || -> daybook_core::Result<String> {
        let mut a = YrsBody::new(1);
        a.insert(0, "# shared body\n")?;
        let mut b = YrsBody::from_snapshot(2, &a.snapshot()?)?;

        a.insert(a.text().len() as u32, "from-browser\n")?;
        b.insert(b.text().len() as u32, "from-desktop\n")?;

        let a_to_b = a.diff(&b.state_vector())?;
        let b_to_a = b.diff(&a.state_vector())?;
        b.apply(&a_to_b)?;
        a.apply(&b_to_a)?;

        if a.text() != b.text() {
            return Err(daybook_core::CoreError::Crdt("replicas diverged".into()));
        }
        if !a.text().contains("from-browser") || !a.text().contains("from-desktop") {
            return Err(daybook_core::CoreError::Crdt("characters lost in merge".into()));
        }
        Ok(a.text())
    };

    match run() {
        Ok(text) => ok(name, format!("merged body:\n{text}")),
        Err(e) => fail(name, e.to_string()),
    }
}

/// Everything the page needs to perform one projection write, computed in Rust:
/// a UUIDv7 id, a fractional order key, an HLC-ish stamp, and a `Y.Text` body
/// rendered to markdown. JS only binds these into the INSERT.
#[wasm_bindgen]
pub fn build_node_write(device_id: &str) -> JsValue {
    let device = DeviceId::from(device_id);

    let mut body = YrsBody::new(7);
    let _ = body.insert(0, "## Goal\nProve the wasm32 core writes through OPFS.\n");
    let _ = body.insert(8, "(edited in wasm) ");

    #[derive(Serialize)]
    struct NodeWrite {
        id: String,
        title: String,
        body_md: String,
        order_key: String,
        hlc: String,
    }

    serde_wasm_bindgen::to_value(&NodeWrite {
        id: daybook_core::new_id().to_string(),
        title: "Written by daybook-core on wasm32".into(),
        body_md: body.text(),
        order_key: order_key::between(None, None, &device),
        hlc: format!("wasm-{device_id}"),
    })
    .unwrap_or(JsValue::NULL)
}

/// Verifies a row JS read back out of OPFS-backed SQLite against what Rust wrote.
/// The comparison lives in Rust so the page cannot accidentally assert nothing.
#[wasm_bindgen]
pub fn verify_round_trip(expected_body: &str, actual_body: &str, row_count: u32) -> JsValue {
    let name = "SQLite write/read (sqlite-wasm + OPFS)";
    if row_count != 1 {
        return fail(name, format!("expected exactly 1 row, read {row_count}"));
    }
    if expected_body != actual_body {
        return fail(
            name,
            format!("body mismatch\n  wrote: {expected_body:?}\n  read:  {actual_body:?}"),
        );
    }
    ok(
        name,
        format!("{row_count} row round-tripped; body matched ({} bytes)", actual_body.len()),
    )
}

/// Order keys generated in WASM must sort the same way SQLite's `ORDER BY` does.
/// The page writes these rows and reads them back sorted; this builds them.
#[wasm_bindgen]
pub fn build_order_keys(device_id: &str, count: u32) -> Vec<String> {
    let device = DeviceId::from(device_id);
    let mut keys: Vec<String> = Vec::new();
    for _ in 0..count {
        let next = order_key::between(keys.last().map(String::as_str), None, &device);
        keys.push(next);
    }
    keys
}
