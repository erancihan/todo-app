//! The Tauri v2 shell — the native half of the engine port.
//!
//! Every command here is a thin marshalling layer over
//! [`daybook_core::Engine`]. The browser half (`daybook_core::wasm`) is equally
//! thin over the same engine, so the two hosts cannot disagree about behaviour:
//! there is only one implementation of it, and both call it.
//!
//! Commands are named to match the WASM exports one-for-one, which is what lets
//! `app/src/core/engine-port.ts` present a single interface with no per-host
//! special cases.

use std::sync::Mutex;

use daybook_core::engine::{BlobMeta, BlobView};
use daybook_core::ids::DeviceId;
use daybook_core::node::StatusCategory;
use daybook_core::report::{Report, ReportOptions};
use daybook_core::store::SqliteStore;
use daybook_core::{CollectionView, Engine, EventView, NodeView, StatusView, TagView};
use tauri::Manager;

/// The engine, plus the identity it runs under.
struct AppState {
    engine: Mutex<Engine<SqliteStore>>,
}

/// Tauri command errors must be serializable; `CoreError` is not, so flatten to
/// a string at the boundary. The UI renders these directly.
type CmdResult<T> = Result<T, String>;

fn to_err(e: daybook_core::CoreError) -> String {
    e.to_string()
}

/// The account this install is running as.
///
/// Hard-coded for Phase 1, which ships single-account — but it is threaded
/// through as a real value rather than assumed, because every store key is
/// already account-scoped. Adding the host/account switcher later is a change to
/// where this string comes from, not a migration (roadmap Phase 1 exit criterion).
const LOCAL_ACCOUNT: &str = "local";

/// A stable per-install device identity, used for HLC tie-breaks and order-key
/// jitter. Persisted next to the database: regenerating it on every launch would
/// make this machine look like a brand-new replica each time, which breaks both.
fn load_or_create_device_id(dir: &std::path::Path) -> DeviceId {
    let path = dir.join("device-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return DeviceId::from(trimmed);
        }
    }
    let fresh = DeviceId::generate();
    // Best-effort: a failed write costs us a stable id, not correctness.
    let _ = std::fs::write(&path, fresh.as_str());
    fresh
}

#[tauri::command]
fn runtime() -> String {
    format!("tauri/{}", std::env::consts::OS)
}

#[tauri::command]
fn list_tree(state: tauri::State<'_, AppState>) -> CmdResult<Vec<NodeView>> {
    state.engine.lock().unwrap().list_tree().map_err(to_err)
}

#[tauri::command]
fn node(state: tauri::State<'_, AppState>, id: String) -> CmdResult<Option<NodeView>> {
    state.engine.lock().unwrap().node(&id).map_err(to_err)
}

#[tauri::command]
fn create_node(
    state: tauri::State<'_, AppState>,
    parent_id: Option<String>,
    title: String,
    after: Option<String>,
) -> CmdResult<NodeView> {
    state
        .engine
        .lock()
        .unwrap()
        .create_node(parent_id.as_deref(), &title, after.as_deref())
        .map_err(to_err)
}

#[tauri::command]
fn set_title(state: tauri::State<'_, AppState>, id: String, title: String) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .set_title(&id, &title)
        .map_err(to_err)
}

#[tauri::command]
fn set_body(state: tauri::State<'_, AppState>, id: String, markdown: String) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .set_body(&id, &markdown)
        .map_err(to_err)
}

#[tauri::command]
fn set_status(state: tauri::State<'_, AppState>, id: String, status: String) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .set_status(&id, &status)
        .map_err(to_err)
}

#[tauri::command]
fn set_tag_color(
    state: tauri::State<'_, AppState>,
    tag_id: String,
    color: String,
) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .set_tag_color(&tag_id, &color)
        .map_err(to_err)
}

#[tauri::command]
fn list_statuses(state: tauri::State<'_, AppState>) -> CmdResult<Vec<StatusView>> {
    state.engine.lock().unwrap().list_statuses().map_err(to_err)
}

#[tauri::command]
fn create_status(
    state: tauri::State<'_, AppState>,
    name: String,
    category: String,
    color: Option<String>,
) -> CmdResult<StatusView> {
    state
        .engine
        .lock()
        .unwrap()
        .create_status(&name, StatusCategory::parse(&category), color.as_deref())
        .map_err(to_err)
}

#[tauri::command]
fn rename_status(state: tauri::State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .rename_status(&id, &name)
        .map_err(to_err)
}

#[tauri::command]
fn set_status_color(state: tauri::State<'_, AppState>, id: String, color: String) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .set_status_color(&id, &color)
        .map_err(to_err)
}

#[tauri::command]
fn delete_status(state: tauri::State<'_, AppState>, id: String) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .delete_status(&id)
        .map_err(to_err)
}

#[tauri::command]
fn toggle_done(state: tauri::State<'_, AppState>, id: String) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .toggle_done(&id)
        .map_err(to_err)
}

#[tauri::command]
fn promote(state: tauri::State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.lock().unwrap().promote(&id).map_err(to_err)
}

#[tauri::command]
fn duplicate_node(
    state: tauri::State<'_, AppState>,
    id: String,
    new_parent: Option<String>,
    after: Option<String>,
) -> CmdResult<NodeView> {
    state
        .engine
        .lock()
        .unwrap()
        .duplicate_node(&id, new_parent.as_deref(), after.as_deref())
        .map_err(to_err)
}

#[tauri::command]
fn demote(state: tauri::State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.lock().unwrap().demote(&id).map_err(to_err)
}

#[tauri::command]
fn restore_node(state: tauri::State<'_, AppState>, id: String) -> CmdResult<usize> {
    state
        .engine
        .lock()
        .unwrap()
        .restore_node(&id)
        .map_err(to_err)
}

#[tauri::command]
fn indent(state: tauri::State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.lock().unwrap().indent(&id).map_err(to_err)
}

#[tauri::command]
fn outdent(state: tauri::State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.lock().unwrap().outdent(&id).map_err(to_err)
}

#[tauri::command]
fn move_node(
    state: tauri::State<'_, AppState>,
    id: String,
    new_parent: Option<String>,
    after: Option<String>,
) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .move_node(&id, new_parent.as_deref(), after.as_deref())
        .map_err(to_err)
}

#[tauri::command]
fn delete_node(state: tauri::State<'_, AppState>, id: String) -> CmdResult<usize> {
    state
        .engine
        .lock()
        .unwrap()
        .delete_node(&id)
        .map_err(to_err)
}

#[tauri::command]
fn set_collapsed(state: tauri::State<'_, AppState>, id: String, collapsed: bool) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .set_collapsed(&id, collapsed)
        .map_err(to_err)
}

#[tauri::command]
fn add_tag(state: tauri::State<'_, AppState>, node_id: String, name: String) -> CmdResult<TagView> {
    state
        .engine
        .lock()
        .unwrap()
        .add_tag(&node_id, &name)
        .map_err(to_err)
}

#[tauri::command]
fn remove_tag(state: tauri::State<'_, AppState>, node_id: String, tag_id: String) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .remove_tag(&node_id, &tag_id)
        .map_err(to_err)
}

#[tauri::command]
fn list_tags(state: tauri::State<'_, AppState>) -> CmdResult<Vec<TagView>> {
    state.engine.lock().unwrap().list_tags().map_err(to_err)
}

#[tauri::command]
fn create_collection(
    state: tauri::State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> CmdResult<CollectionView> {
    state
        .engine
        .lock()
        .unwrap()
        .create_collection(&name, parent_id.as_deref())
        .map_err(to_err)
}

#[tauri::command]
fn list_collections(state: tauri::State<'_, AppState>) -> CmdResult<Vec<CollectionView>> {
    state
        .engine
        .lock()
        .unwrap()
        .list_collections()
        .map_err(to_err)
}

#[tauri::command]
fn add_to_collection(
    state: tauri::State<'_, AppState>,
    node_id: String,
    collection_id: String,
) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .add_to_collection(&node_id, &collection_id)
        .map_err(to_err)
}

#[tauri::command]
fn remove_from_collection(
    state: tauri::State<'_, AppState>,
    node_id: String,
    collection_id: String,
) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .remove_from_collection(&node_id, &collection_id)
        .map_err(to_err)
}

#[tauri::command]
fn events_between(
    state: tauri::State<'_, AppState>,
    from_ms: i64,
    to_ms: i64,
) -> CmdResult<Vec<EventView>> {
    state
        .engine
        .lock()
        .unwrap()
        .events_between(from_ms, to_ms)
        .map_err(to_err)
}

#[tauri::command]
fn set_due(state: tauri::State<'_, AppState>, id: String, due_ms: Option<i64>) -> CmdResult<()> {
    state
        .engine
        .lock()
        .unwrap()
        .set_due(&id, due_ms)
        .map_err(to_err)
}

/// Open a URL in the system browser. The WebView must never navigate to an
/// external site itself — a body is user text, and the shell is not a browser.
#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http(s) links open externally".into());
    }
    open::that_detached(&url).map_err(|e| e.to_string())
}

#[tauri::command]
fn put_blob(state: tauri::State<'_, AppState>, mime: String, bytes: Vec<u8>) -> CmdResult<String> {
    state
        .engine
        .lock()
        .unwrap()
        .put_blob(&mime, &bytes)
        .map_err(to_err)
}

#[tauri::command]
fn blob(state: tauri::State<'_, AppState>, hash: String) -> CmdResult<Option<BlobView>> {
    state.engine.lock().unwrap().blob(&hash).map_err(to_err)
}

#[tauri::command]
fn list_blobs(state: tauri::State<'_, AppState>) -> CmdResult<Vec<BlobMeta>> {
    state.engine.lock().unwrap().list_blobs().map_err(to_err)
}

/// The EOD report. The window and UTC offset come from the WebView, which is the
/// only side that knows the viewer's local day boundary.
#[tauri::command]
fn generate_report(state: tauri::State<'_, AppState>, options: ReportOptions) -> CmdResult<Report> {
    state
        .engine
        .lock()
        .unwrap()
        .generate_report(&options)
        .map_err(to_err)
}

#[tauri::command]
fn commit_carry_over(
    state: tauri::State<'_, AppState>,
    node_ids: Vec<String>,
    day_key: String,
) -> CmdResult<usize> {
    state
        .engine
        .lock()
        .unwrap()
        .commit_carry_over(&node_ids, &day_key)
        .map_err(to_err)
}

#[tauri::command]
fn events_for_node(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> CmdResult<Vec<EventView>> {
    state
        .engine
        .lock()
        .unwrap()
        .events_for_node(&node_id)
        .map_err(to_err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // The OS-designated per-app data directory, so the projection lands
            // somewhere the platform will not clear out from under us.
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;

            let device = load_or_create_device_id(&dir);
            // Named for the account: a second account gets its own file rather
            // than sharing one, which is the strongest form of partitioning.
            let store = SqliteStore::open(&dir.join(format!("daybook-{LOCAL_ACCOUNT}.sqlite")))?;
            let engine = Engine::open(store, LOCAL_ACCOUNT, device)?;

            app.manage(AppState {
                engine: Mutex::new(engine),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime,
            list_tree,
            node,
            create_node,
            set_title,
            set_body,
            set_status,
            list_statuses,
            create_status,
            rename_status,
            set_status_color,
            delete_status,
            set_tag_color,
            toggle_done,
            promote,
            demote,
            duplicate_node,
            restore_node,
            indent,
            outdent,
            move_node,
            delete_node,
            set_collapsed,
            add_tag,
            remove_tag,
            list_tags,
            create_collection,
            list_collections,
            add_to_collection,
            remove_from_collection,
            events_between,
            events_for_node,
            set_due,
            open_url,
            put_blob,
            blob,
            list_blobs,
            generate_report,
            commit_carry_over,
        ])
        .run(tauri::generate_context!())
        .expect("error while running daybook");
}
