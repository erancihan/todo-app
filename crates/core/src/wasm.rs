//! The browser half of the engine port — `wasm32` only.
//!
//! This is the counterpart of the Tauri command surface in
//! `app/src-tauri/src/lib.rs`, and the two are deliberately shallow: both do
//! nothing but marshal arguments into [`crate::engine::Engine`] and results back
//! out. All behaviour lives in the engine, so desktop and browser cannot drift.
//!
//! # The inversion that makes this work
//!
//! SQLite in the browser is `sqlite-wasm`, a **JavaScript** package, and OPFS is a
//! browser API — neither is reachable from Rust directly. So [`JsStore`] holds two
//! JS callbacks and implements [`Store`] by calling them.
//!
//! That keeps the dependency arrow pointing the right way. JS supplies a *driver*;
//! Rust still decides everything. The alternative — Rust handing SQL strings up to
//! a JS layer that interprets them — would have put engine logic in TypeScript,
//! which is exactly the split this architecture exists to avoid.

use std::cell::RefCell;

use wasm_bindgen::prelude::*;

use crate::engine::Engine;
use crate::ids::DeviceId;
use crate::node::Status;
use crate::report::ReportOptions;
use crate::store::{Row, SqlValue, Store};
use crate::{CoreError, Result};

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// A [`Store`] backed by `sqlite-wasm` + OPFS in the host page.
///
/// `execute(sql, params) -> number` and `query(sql, params) -> unknown[][]` are
/// supplied by JS; both are synchronous, which OPFS supports through
/// `FileSystemSyncAccessHandle` inside a Worker. Synchronous is what lets the
/// engine keep ordinary Rust control flow instead of colouring every method async.
pub struct JsStore {
    execute: js_sys::Function,
    query: js_sys::Function,
}

impl JsStore {
    pub fn new(execute: js_sys::Function, query: js_sys::Function) -> Self {
        Self { execute, query }
    }

    fn params_to_js(params: &[SqlValue]) -> js_sys::Array {
        let array = js_sys::Array::new();
        for value in params {
            array.push(&match value {
                SqlValue::Null => JsValue::NULL,
                SqlValue::Int(i) => JsValue::from_f64(*i as f64),
                SqlValue::Real(f) => JsValue::from_f64(*f),
                SqlValue::Text(s) => JsValue::from_str(s),
            });
        }
        array
    }

    fn js_to_value(value: &JsValue) -> SqlValue {
        if value.is_null() || value.is_undefined() {
            SqlValue::Null
        } else if let Some(n) = value.as_f64() {
            // SQLite INTEGER columns come back as JS numbers. Treat a whole number
            // as an integer so `as_i64` works on timestamps and flags; anything
            // fractional stays real.
            if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
                SqlValue::Int(n as i64)
            } else {
                SqlValue::Real(n)
            }
        } else if let Some(s) = value.as_string() {
            SqlValue::Text(s)
        } else if let Some(b) = value.as_bool() {
            SqlValue::Int(b as i64)
        } else {
            SqlValue::Null
        }
    }

    fn call_error(what: &str, e: JsValue) -> CoreError {
        CoreError::Store(format!(
            "{what}: {}",
            e.as_string()
                .or_else(|| js_sys::Reflect::get(&e, &JsValue::from_str("message"))
                    .ok()
                    .and_then(|m| m.as_string()))
                .unwrap_or_else(|| format!("{e:?}"))
        ))
    }
}

impl Store for JsStore {
    fn execute(&self, sql: &str, params: &[SqlValue]) -> Result<u64> {
        let result = self
            .execute
            .call2(
                &JsValue::NULL,
                &JsValue::from_str(sql),
                &Self::params_to_js(params),
            )
            .map_err(|e| Self::call_error("sqlite execute", e))?;
        Ok(result.as_f64().unwrap_or(0.0) as u64)
    }

    fn execute_batch(&self, sql: &str) -> Result<()> {
        // sqlite-wasm's `exec` runs multiple statements, so a batch is just an
        // execute with no parameters.
        self.execute(sql, &[]).map(|_| ())
    }

    fn query(&self, sql: &str, params: &[SqlValue]) -> Result<Vec<Row>> {
        let result = self
            .query
            .call2(
                &JsValue::NULL,
                &JsValue::from_str(sql),
                &Self::params_to_js(params),
            )
            .map_err(|e| Self::call_error("sqlite query", e))?;

        let rows = js_sys::Array::from(&result);
        let mut out = Vec::with_capacity(rows.length() as usize);
        for row in rows.iter() {
            let cells = js_sys::Array::from(&row);
            out.push(cells.iter().map(|c| Self::js_to_value(&c)).collect::<Row>());
        }
        Ok(out)
    }
}

/// The engine, as the browser sees it.
///
/// Every method mirrors a Tauri command of the same name. Results cross as plain
/// JS values via `serde_wasm_bindgen`, so the TypeScript side sees identical
/// shapes on both hosts and needs no per-host adapters.
#[wasm_bindgen]
pub struct DaybookEngine {
    inner: RefCell<Engine<JsStore>>,
}

/// Serialize with `Option::None` as `null`, **not** `undefined`.
///
/// This is not cosmetic. `serde_wasm_bindgen` defaults to `undefined`, while the
/// Tauri host goes through `serde_json` and produces `null` — so the same field
/// on the same node had two different values depending on the host, and the
/// TypeScript types (`string | null`) described only one of them. Any `=== null`
/// test in the shared UI silently answered `false` in the browser: it is what
/// made `n` insert at the top of the list there and below the focused row on the
/// desktop, from identical code.
fn to_js<T: serde::Serialize>(value: &T) -> std::result::Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    value
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

fn err(e: CoreError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
impl DaybookEngine {
    /// Build an engine over JS-supplied SQLite callbacks and apply the schema.
    #[wasm_bindgen(constructor)]
    pub fn new(
        execute: js_sys::Function,
        query: js_sys::Function,
        account_id: String,
        device_id: String,
    ) -> std::result::Result<DaybookEngine, JsValue> {
        let store = JsStore::new(execute, query);
        let engine =
            Engine::open(store, account_id, DeviceId::from(device_id.as_str())).map_err(err)?;
        Ok(Self {
            inner: RefCell::new(engine),
        })
    }

    pub fn runtime(&self) -> String {
        "wasm/browser".into()
    }

    #[wasm_bindgen(js_name = createNode)]
    pub fn create_node(
        &self,
        parent_id: Option<String>,
        title: String,
        after: Option<String>,
    ) -> std::result::Result<JsValue, JsValue> {
        let node = self
            .inner
            .borrow()
            .create_node(parent_id.as_deref(), &title, after.as_deref())
            .map_err(err)?;
        to_js(&node)
    }

    #[wasm_bindgen(js_name = listTree)]
    pub fn list_tree(&self) -> std::result::Result<JsValue, JsValue> {
        to_js(&self.inner.borrow().list_tree().map_err(err)?)
    }

    pub fn node(&self, id: String) -> std::result::Result<JsValue, JsValue> {
        to_js(&self.inner.borrow().node(&id).map_err(err)?)
    }

    #[wasm_bindgen(js_name = setTitle)]
    pub fn set_title(&self, id: String, title: String) -> std::result::Result<(), JsValue> {
        self.inner.borrow().set_title(&id, &title).map_err(err)
    }

    #[wasm_bindgen(js_name = setBody)]
    pub fn set_body(&self, id: String, markdown: String) -> std::result::Result<(), JsValue> {
        self.inner.borrow().set_body(&id, &markdown).map_err(err)
    }

    #[wasm_bindgen(js_name = setStatus)]
    pub fn set_status(&self, id: String, status: String) -> std::result::Result<(), JsValue> {
        self.inner
            .borrow()
            .set_status(&id, Status::parse(&status))
            .map_err(err)
    }

    #[wasm_bindgen(js_name = toggleDone)]
    pub fn toggle_done(&self, id: String) -> std::result::Result<(), JsValue> {
        self.inner.borrow().toggle_done(&id).map_err(err)
    }

    pub fn promote(&self, id: String) -> std::result::Result<(), JsValue> {
        self.inner.borrow().promote(&id).map_err(err)
    }

    #[wasm_bindgen(js_name = duplicateNode)]
    pub fn duplicate_node(
        &self,
        id: String,
        new_parent: Option<String>,
        after: Option<String>,
    ) -> std::result::Result<JsValue, JsValue> {
        to_js(
            &self
                .inner
                .borrow()
                .duplicate_node(&id, new_parent.as_deref(), after.as_deref())
                .map_err(err)?,
        )
    }

    pub fn demote(&self, id: String) -> std::result::Result<(), JsValue> {
        self.inner.borrow().demote(&id).map_err(err)
    }

    #[wasm_bindgen(js_name = restoreNode)]
    pub fn restore_node(&self, id: String) -> std::result::Result<usize, JsValue> {
        self.inner.borrow().restore_node(&id).map_err(err)
    }

    pub fn indent(&self, id: String) -> std::result::Result<(), JsValue> {
        self.inner.borrow().indent(&id).map_err(err)
    }

    pub fn outdent(&self, id: String) -> std::result::Result<(), JsValue> {
        self.inner.borrow().outdent(&id).map_err(err)
    }

    #[wasm_bindgen(js_name = moveNode)]
    pub fn move_node(
        &self,
        id: String,
        new_parent: Option<String>,
        after: Option<String>,
    ) -> std::result::Result<(), JsValue> {
        self.inner
            .borrow()
            .move_node(&id, new_parent.as_deref(), after.as_deref())
            .map_err(err)
    }

    #[wasm_bindgen(js_name = deleteNode)]
    pub fn delete_node(&self, id: String) -> std::result::Result<usize, JsValue> {
        self.inner.borrow().delete_node(&id).map_err(err)
    }

    #[wasm_bindgen(js_name = setCollapsed)]
    pub fn set_collapsed(&self, id: String, collapsed: bool) -> std::result::Result<(), JsValue> {
        self.inner
            .borrow()
            .set_collapsed(&id, collapsed)
            .map_err(err)
    }

    #[wasm_bindgen(js_name = addTag)]
    pub fn add_tag(&self, node_id: String, name: String) -> std::result::Result<JsValue, JsValue> {
        to_js(&self.inner.borrow().add_tag(&node_id, &name).map_err(err)?)
    }

    #[wasm_bindgen(js_name = removeTag)]
    pub fn remove_tag(&self, node_id: String, tag_id: String) -> std::result::Result<(), JsValue> {
        self.inner
            .borrow()
            .remove_tag(&node_id, &tag_id)
            .map_err(err)
    }

    #[wasm_bindgen(js_name = listTags)]
    pub fn list_tags(&self) -> std::result::Result<JsValue, JsValue> {
        to_js(&self.inner.borrow().list_tags().map_err(err)?)
    }

    #[wasm_bindgen(js_name = createCollection)]
    pub fn create_collection(
        &self,
        name: String,
        parent_id: Option<String>,
    ) -> std::result::Result<JsValue, JsValue> {
        to_js(
            &self
                .inner
                .borrow()
                .create_collection(&name, parent_id.as_deref())
                .map_err(err)?,
        )
    }

    #[wasm_bindgen(js_name = listCollections)]
    pub fn list_collections(&self) -> std::result::Result<JsValue, JsValue> {
        to_js(&self.inner.borrow().list_collections().map_err(err)?)
    }

    #[wasm_bindgen(js_name = addToCollection)]
    pub fn add_to_collection(
        &self,
        node_id: String,
        collection_id: String,
    ) -> std::result::Result<(), JsValue> {
        self.inner
            .borrow()
            .add_to_collection(&node_id, &collection_id)
            .map_err(err)
    }

    #[wasm_bindgen(js_name = removeFromCollection)]
    pub fn remove_from_collection(
        &self,
        node_id: String,
        collection_id: String,
    ) -> std::result::Result<(), JsValue> {
        self.inner
            .borrow()
            .remove_from_collection(&node_id, &collection_id)
            .map_err(err)
    }

    #[wasm_bindgen(js_name = eventsBetween)]
    pub fn events_between(
        &self,
        from_ms: f64,
        to_ms: f64,
    ) -> std::result::Result<JsValue, JsValue> {
        to_js(
            &self
                .inner
                .borrow()
                .events_between(from_ms as i64, to_ms as i64)
                .map_err(err)?,
        )
    }

    #[wasm_bindgen(js_name = eventsForNode)]
    pub fn events_for_node(&self, node_id: String) -> std::result::Result<JsValue, JsValue> {
        to_js(&self.inner.borrow().events_for_node(&node_id).map_err(err)?)
    }

    /// The EOD report. `options` is a [`crate::report::ReportOptions`] as a plain
    /// JS object — the host owns the timezone, so it supplies the day window and
    /// the UTC offset rather than core guessing either.
    #[wasm_bindgen(js_name = generateReport)]
    pub fn generate_report(&self, options: JsValue) -> std::result::Result<JsValue, JsValue> {
        let options: ReportOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        to_js(&self.inner.borrow().generate_report(&options).map_err(err)?)
    }

    #[wasm_bindgen(js_name = commitCarryOver)]
    pub fn commit_carry_over(
        &self,
        node_ids: Vec<String>,
        day_key: String,
    ) -> std::result::Result<usize, JsValue> {
        self.inner
            .borrow()
            .commit_carry_over(&node_ids, &day_key)
            .map_err(err)
    }
}
