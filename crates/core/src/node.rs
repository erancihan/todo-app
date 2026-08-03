//! The NODE — a todo *and* a promoted sub-item are the same row
//! (docs/03-data-model.md §3.1).
//!
//! **Phase 0 scope:** types only. The tree engine (promotion, indent/outdent,
//! depth cap, cycle guard) lands in Phase 1.

use serde::{Deserialize, Serialize};

use crate::hlc::Hlc;
use crate::ids::Id;

/// A lightweight child versus a full todo. `promoted` is what levels one up; the
/// row itself never changes shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Task,
    ChecklistItem,
}

/// Drives the report buckets. `Done` sets `completed_at`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Inbox,
    Todo,
    InProgress,
    Blocked,
    Done,
    Dropped,
}

/// Maximum tree depth. Promotion unlocks children, so the guard is enforced on
/// every structural op (docs/03-data-model.md §9).
pub const MAX_DEPTH: usize = 8;

/// A row in the single NODE table.
///
/// `body_md` is deliberately absent: the body lives in its own `Y.Text` document
/// behind [`crate::body::BodyCrdt`], and the projection materializes it as a
/// string only when it writes SQLite. Keeping it off this struct stops callers
/// from treating the body as an LWW scalar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: Id,
    /// `None` = root todo. Self-referential tree edge, preserved across promotion.
    pub parent_id: Option<Id>,
    pub kind: Kind,
    pub promoted: bool,
    pub title: String,
    pub status: Status,
    /// base62 fractional index + `:deviceId` jitter (see [`crate::order_key`]).
    pub order_key: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub due_at: Option<i64>,
    pub completed_at: Option<i64>,
    /// Soft delete. Rows are retained for merge and GC'd only behind a causal
    /// watermark — premature GC resurrects deleted todos.
    pub deleted: bool,
    pub deleted_at: Option<i64>,
    /// Per-field LWW stamp. Phase 2 refines this to per-field versions.
    pub hlc: Hlc,
}
