//! Content-addressed blob queue (docs/02-architecture.md ADR-003).
//!
//! Image bytes never enter the CRDT or the op log — the op log carries only the
//! SHA-256 hash, metadata, and a blurhash, and the bytes travel their own channel.
//! That separation is what lets a list render instantly from the blurhash while
//! full images lazy-load, and lets the cache evict without touching todo data.
//!
//! **Phase 0 scope:** types only. Hashing, thumbnailing (the `image` crate), the
//! offline upload/download queue, and the LRU cache are Phase 2.

use serde::{Deserialize, Serialize};

/// Where a blob's bytes are, from this device's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheState {
    /// Bytes are on this device.
    Cached,
    /// The relay has them; we have only the hash and blurhash.
    RemoteOnly,
    /// Waiting in the offline transfer queue.
    Queued,
}

/// Device-local bookkeeping for one content-addressed blob. Not itself synced as
/// todo data — the synced half is [`Attachment`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Blob {
    /// SHA-256 of the bytes. Identity, dedup key, and integrity check in one.
    pub content_hash: String,
    pub ref_count: u32,
    pub remote_key: Option<String>,
    pub cache_state: CacheState,
}

/// The synced half — metadata only, small enough to live in the op log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub node_id: String,
    pub content_hash: String,
    pub mime: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    /// Blurhash / tiny base64 thumbnail, inline. This is what renders when the
    /// bytes have not arrived yet — the UI must never block on a blob.
    pub thumb_hash: String,
    pub deleted: bool,
}
