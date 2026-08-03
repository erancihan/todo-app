//! The relay's storage trait — the seam that keeps "scale up to Postgres + S3" a
//! config change instead of a rewrite (docs/02-architecture.md §7.1).
//!
//! The default backend is embedded SQLite, chosen because the relay's entire
//! schema is roughly five tables of *opaque* data with an append + read-since-cursor
//! access pattern. The one delicate operation — assigning the per-collection
//! monotonic sequence number — is *simpler* on a single node, not harder.
//!
//! **Phase 0 scope:** the trait and the SQLite schema. Append, read-since-cursor,
//! fan-out, and the blob-ticket half are Phase 2.

use std::path::Path;

/// The relay's durable store. A Postgres implementation slots in here.
pub trait OpLogStore {
    fn init_schema(&mut self) -> Result<(), StorageError>;

    /// Append one opaque op to a collection's log, returning the assigned
    /// monotonic sequence number. Clients read back with `since = seq`.
    ///
    /// Phase 2. Present now so the trait's shape is fixed before implementations
    /// multiply — fixing it late is what forces a Postgres backend to be a
    /// rewrite instead of a config change.
    #[allow(dead_code, reason = "Phase 2 — no caller until the sync channel lands")]
    fn append(&mut self, collection_id: &str, payload: &[u8]) -> Result<u64, StorageError>;
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[allow(
        dead_code,
        reason = "Phase 2 — returned only by the unimplemented append"
    )]
    #[error("not implemented until Phase 2: {0}")]
    NotYetImplemented(&'static str),
}

/// Five tables of opaque data. `op_log.payload` is a client-produced blob — the
/// relay never parses it, which is exactly why the relay stays dumb.
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES account(id),
  last_seen_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collection (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES account(id),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_member (
  collection_id TEXT NOT NULL REFERENCES collection(id),
  account_id    TEXT NOT NULL REFERENCES account(id),
  role          TEXT NOT NULL CHECK (role IN ('owner','collaborator','viewer')),
  tombstone     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, account_id)
);

-- The op log. `seq` is per-collection and monotonic; clients sync with
-- "give me everything after cursor N".
CREATE TABLE IF NOT EXISTS op_log (
  collection_id TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  device_id     TEXT NOT NULL,
  payload       BLOB NOT NULL,
  received_at   INTEGER NOT NULL,
  PRIMARY KEY (collection_id, seq)
);

CREATE TABLE IF NOT EXISTS blob_index (
  content_hash  TEXT PRIMARY KEY,
  byte_size     INTEGER NOT NULL,
  mime          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
"#;

pub struct SqliteOpLogStore {
    conn: rusqlite::Connection,
}

impl SqliteOpLogStore {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        let conn = rusqlite::Connection::open(path)?;
        // WAL keeps readers off the single writer's back — the right default for a
        // one-vCPU box serving a handful of devices.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(Self { conn })
    }
}

impl OpLogStore for SqliteOpLogStore {
    fn init_schema(&mut self) -> Result<(), StorageError> {
        self.conn.execute_batch(SCHEMA_SQL)?;
        Ok(())
    }

    fn append(&mut self, _collection_id: &str, _payload: &[u8]) -> Result<u64, StorageError> {
        Err(StorageError::NotYetImplemented("op-log append (Phase 2)"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_applies_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("daybook-relay-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = SqliteOpLogStore::open(&dir.join("relay.sqlite")).unwrap();
        store.init_schema().unwrap();
        store.init_schema().unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
