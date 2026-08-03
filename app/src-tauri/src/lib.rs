//! The Tauri v2 shell.
//!
//! This is the *native* half of the engine port (docs/02-architecture.md §3). The
//! browser build reaches the identical `daybook-core` API through WASM calls
//! instead; the TypeScript `EnginePort` interface in `app/src/core/engine-port.ts`
//! is the same on both sides, and these commands are one of its two backings.
//!
//! **Phase 0 scope:** the commands the proof-of-stack spike needs — a string
//! round-trip through Rust, a native `yrs` convergence check, and a native SQLite
//! write/read. The real command surface arrives with the Phase 1 engine.

use daybook_core::body::{BodyCrdt, YrsBody};
use daybook_core::store::{NodeRow, SqliteStore, Store};
use serde::Serialize;

/// What every Phase 0 probe reports back to the UI, so the spike page can render a
/// visible pass/fail rather than a console log.
#[derive(Debug, Serialize)]
pub struct ProbeResult {
    pub name: String,
    pub passed: bool,
    pub detail: String,
}

/// Phase 0 exit criterion: "calling one Tauri command into `crates/core`
/// (round-trip a string through Rust)".
#[tauri::command]
fn core_echo(input: String) -> String {
    daybook_core::echo(&input)
}

/// Runs the `yrs` concurrent-edit convergence check natively, inside the WebView
/// host process, and reports whether both devices' characters survived.
#[tauri::command]
fn core_body_probe() -> ProbeResult {
    let run = || -> daybook_core::Result<String> {
        let mut a = YrsBody::new(1);
        a.insert(0, "# shared body\n")?;
        let mut b = YrsBody::from_snapshot(2, &a.snapshot()?)?;

        // Both devices edit offline.
        a.insert(a.text().len() as u32, "from-desktop\n")?;
        b.insert(b.text().len() as u32, "from-phone\n")?;

        // Exchange.
        let a_to_b = a.diff(&b.state_vector())?;
        let b_to_a = b.diff(&a.state_vector())?;
        b.apply(&a_to_b)?;
        a.apply(&b_to_a)?;

        if a.text() != b.text() {
            return Err(daybook_core::CoreError::Crdt("replicas diverged".into()));
        }
        if !a.text().contains("from-desktop") || !a.text().contains("from-phone") {
            return Err(daybook_core::CoreError::Crdt(
                "characters lost in merge".into(),
            ));
        }
        Ok(a.text())
    };

    match run() {
        Ok(text) => ProbeResult {
            name: "yrs Y.Text converges (native)".into(),
            passed: true,
            detail: format!("merged body:\n{text}"),
        },
        Err(e) => ProbeResult {
            name: "yrs Y.Text converges (native)".into(),
            passed: false,
            detail: e.to_string(),
        },
    }
}

/// Native SQLite write/read through `rusqlite` — the counterpart of the browser
/// build's `sqlite-wasm` + OPFS path. Same `SCHEMA_SQL`, same `Store` trait.
#[tauri::command]
fn core_store_probe() -> ProbeResult {
    let run = || -> daybook_core::Result<String> {
        let mut store = SqliteStore::in_memory()?;
        store.init_schema()?;

        let row = NodeRow {
            id: daybook_core::new_id().to_string(),
            title: "Written from the Tauri shell".into(),
            body_md: "## Goal\nProve the native store path.".into(),
            order_key: "V:tauri".into(),
            hlc: "native".into(),
        };
        store.upsert_node("acct-local", &row)?;

        let read_back = store
            .load_node("acct-local", &row.id)?
            .ok_or_else(|| daybook_core::CoreError::Store("row vanished after write".into()))?;

        if read_back != row {
            return Err(daybook_core::CoreError::Store("read-back mismatch".into()));
        }
        Ok(format!(
            "wrote and read node {} ({} live row(s) for acct-local)",
            row.id,
            store.count_nodes("acct-local")?
        ))
    };

    match run() {
        Ok(detail) => ProbeResult {
            name: "SQLite write/read (native rusqlite)".into(),
            passed: true,
            detail,
        },
        Err(e) => ProbeResult {
            name: "SQLite write/read (native rusqlite)".into(),
            passed: false,
            detail: e.to_string(),
        },
    }
}

/// Which engine-port implementation is live. The UI renders this so it is obvious
/// at a glance whether a page is running under Tauri or as the PWA.
#[tauri::command]
fn core_runtime() -> String {
    format!("tauri/{}", std::env::consts::OS)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            core_echo,
            core_body_probe,
            core_store_probe,
            core_runtime
        ])
        .run(tauri::generate_context!())
        .expect("error while running daybook");
}
