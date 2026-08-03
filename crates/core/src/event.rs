//! The append-only EVENT log — the source of truth for history and the input to
//! the EOD report engine (docs/03-data-model.md §3.5).
//!
//! Events are immutable and HLC-stamped, which is exactly what makes a fixed date
//! range always reproduce the same report.
//!
//! **Phase 0 scope:** types only. The log is written from Phase 1; the report
//! engine that reads it is Phase 3.

use serde::{Deserialize, Serialize};

use crate::hlc::Hlc;
use crate::ids::{DeviceId, Id};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    Created,
    Updated,
    StatusChanged,
    Completed,
    Reopened,
    Promoted,
    CollectionAdded,
    CollectionRemoved,
    Tagged,
    Untagged,
    Attached,
    Commented,
    CarriedOver,
}

/// One immutable entry in the log. Never edited or deleted — only compacted
/// behind a causal watermark.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: Id,
    pub node_id: Id,
    /// Originating device/user.
    pub actor_id: DeviceId,
    pub r#type: EventType,
    pub from_value: Option<serde_json::Value>,
    pub to_value: Option<serde_json::Value>,
    /// HLC + UTC, so the day boundary survives DST and travel.
    pub occurred_at: Hlc,
    pub payload_json: Option<serde_json::Value>,
}

/// The buckets an EOD report sorts events into (docs/03-data-model.md §8.2).
/// Present in Phase 0 so the log's consumers are visible from the start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReportBucket {
    Created,
    Updated,
    Completed,
    CarriedOver,
}
