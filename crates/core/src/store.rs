//! The SQLite projection, and the one seam where the native and wasm32 builds
//! differ (docs/02-architecture.md §3).
//!
//! SQLite is a **deterministic projection**, never a primary. It is queried, not
//! authored, and is rebuildable from the log.
//!
//! # Why this trait is deliberately tiny
//!
//! [`Store`] executes SQL and returns rows. That is all it does. It makes no
//! decisions, owns no schema knowledge, and has no idea what a NODE is.
//!
//! Everything that *thinks* — ordering, promotion, the event log, tree invariants —
//! lives above it in [`crate::engine`], written once and shared verbatim by both
//! targets. Widening this trait is how the two builds would drift into two
//! implementations of the same logic, so it stays narrow on purpose:
//!
//! * **native** — [`SqliteStore`] over `rusqlite`, inside the Tauri shell.
//! * **wasm32** — `JsStore` (see [`crate::wasm`]) forwarding to `sqlite-wasm` +
//!   OPFS in the host JS environment. `rusqlite` never enters the wasm graph.

use serde::{Deserialize, Serialize};

use crate::Result;

/// A SQLite scalar, in the narrow set the projection actually uses.
///
/// No `Blob` variant: image bytes live outside the projection entirely
/// (docs/02-architecture.md ADR-003), and the one binary value that *is* stored —
/// a body's CRDT state — travels as base64 `Text` so the JS side needs no special
/// handling. Adding `Blob` here would mean binary marshalling across the wasm
/// boundary for no current caller.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SqlValue {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    /// Raw bytes. Attachments are stored as blobs rather than base64 text —
    /// base64 costs a third more space and a decode on every read, on the one
    /// kind of value where size actually matters.
    Blob(Vec<u8>),
}

impl SqlValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            SqlValue::Text(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            SqlValue::Int(i) => Some(*i),
            SqlValue::Real(f) => Some(*f as i64),
            _ => None,
        }
    }

    /// Text, or empty when NULL — the common case for projected columns that are
    /// `NOT NULL DEFAULT ''` but arrive through a LEFT JOIN.
    pub fn text_or_default(&self) -> String {
        self.as_str().unwrap_or_default().to_owned()
    }

    pub fn as_blob(&self) -> Option<&[u8]> {
        match self {
            SqlValue::Blob(b) => Some(b),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, SqlValue::Null)
    }

    pub fn as_bool(&self) -> bool {
        self.as_i64().is_some_and(|i| i != 0)
    }
}

impl From<&str> for SqlValue {
    fn from(s: &str) -> Self {
        SqlValue::Text(s.to_owned())
    }
}
impl From<String> for SqlValue {
    fn from(s: String) -> Self {
        SqlValue::Text(s)
    }
}
impl From<i64> for SqlValue {
    fn from(i: i64) -> Self {
        SqlValue::Int(i)
    }
}
impl From<Vec<u8>> for SqlValue {
    fn from(value: Vec<u8>) -> Self {
        SqlValue::Blob(value)
    }
}

impl From<bool> for SqlValue {
    fn from(b: bool) -> Self {
        SqlValue::Int(b as i64)
    }
}
impl<T: Into<SqlValue>> From<Option<T>> for SqlValue {
    fn from(v: Option<T>) -> Self {
        v.map_or(SqlValue::Null, Into::into)
    }
}

/// One result row, in the column order the query asked for.
pub type Row = Vec<SqlValue>;

/// The storage half of the engine port. Two implementations, one contract.
pub trait Store {
    /// Run one statement. Returns rows affected.
    fn execute(&self, sql: &str, params: &[SqlValue]) -> Result<u64>;

    /// Run several statements with no parameters — schema setup and migrations.
    fn execute_batch(&self, sql: &str) -> Result<()>;

    /// Run one query.
    fn query(&self, sql: &str, params: &[SqlValue]) -> Result<Vec<Row>>;
}

/// Convenience helpers, provided for every [`Store`].
pub trait StoreExt: Store {
    /// Apply the projection schema. Idempotent — safe on every boot.
    fn init_schema(&self) -> Result<()> {
        self.execute_batch(SCHEMA_SQL)
    }

    /// First row of a query, if any.
    fn query_one(&self, sql: &str, params: &[SqlValue]) -> Result<Option<Row>> {
        Ok(self.query(sql, params)?.into_iter().next())
    }

    /// First column of the first row as an integer.
    fn query_i64(&self, sql: &str, params: &[SqlValue]) -> Result<Option<i64>> {
        Ok(self
            .query_one(sql, params)?
            .and_then(|r| r.first().and_then(SqlValue::as_i64)))
    }

    /// Run `f` inside a transaction, rolling back if it fails.
    ///
    /// Every engine mutation goes through this: a state change and the EVENT it
    /// emits must land together or not at all, or the log stops being a faithful
    /// record of what happened.
    fn transaction<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.execute("BEGIN IMMEDIATE", &[])?;
        match f() {
            Ok(value) => {
                self.execute("COMMIT", &[])?;
                Ok(value)
            }
            Err(e) => {
                // Best-effort: if the rollback itself fails the original error is
                // still the more useful one to surface.
                let _ = self.execute("ROLLBACK", &[]);
                Err(e)
            }
        }
    }
}

impl<S: Store + ?Sized> StoreExt for S {}

/// The projection schema.
///
/// Every table is account-scoped from day one (roadmap Phase 1 exit criterion:
/// "store keys are account-scoped so a second account would slot in without
/// migration"). It is a plain `&str` so the wasm build hands it to `sqlite-wasm`
/// verbatim — one schema, two drivers, no chance of drift.
pub const SCHEMA_SQL: &str = r#"
PRAGMA foreign_keys = ON;

-- The single NODE table: a todo and a promoted sub-item are the same row.
CREATE TABLE IF NOT EXISTS node (
  account_id   TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  parent_id    TEXT,
  kind         TEXT    NOT NULL DEFAULT 'task',
  promoted     INTEGER NOT NULL DEFAULT 0,
  title        TEXT    NOT NULL DEFAULT '',
  body_md      TEXT    NOT NULL DEFAULT '',
  -- The body's Y.Text document, base64-encoded. Kept alongside the materialized
  -- markdown so Phase 2 sync has real CRDT state to merge rather than a string
  -- it would have to guess the history of.
  body_state   TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'inbox',
  order_key    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0,
  due_at       INTEGER,
  -- The civil day ("YYYY-MM-DD") the user plans to DO this, as distinct from
  -- due_at, the instant it must be finished by. A civil date, not a timestamp:
  -- "do it Tuesday" names a calendar day wherever you wake up, and converting
  -- through UTC would shift it overnight for half the planet.
  scheduled_for TEXT,
  completed_at INTEGER,
  collapsed    INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER,
  hlc          TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, id)
);
-- The list query is "children of P, in order" — this index is that query.
CREATE INDEX IF NOT EXISTS node_by_parent
  ON node (account_id, parent_id, order_key);

-- The append-only EVENT log. Immutable: the report's source of truth.
CREATE TABLE IF NOT EXISTS event (
  account_id  TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  node_id     TEXT    NOT NULL,
  actor_id    TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  from_value  TEXT,
  to_value    TEXT,
  occurred_at TEXT    NOT NULL,
  occurred_ms INTEGER NOT NULL DEFAULT 0,
  payload     TEXT,
  PRIMARY KEY (account_id, id)
);
-- The EOD report is a range scan over this.
CREATE INDEX IF NOT EXISTS event_by_time ON event (account_id, occurred_ms);
CREATE INDEX IF NOT EXISTS event_by_node ON event (account_id, node_id);

-- User-defined statuses. The engine reads only `category`; names, colours and
-- how many exist are the user's. Built-ins are seeded with ids equal to the old
-- enum strings ('todo', 'in_progress', …) so pre-existing node rows resolve with
-- no migration — the node.status column value simply *is* a status id now.
CREATE TABLE IF NOT EXISTS status (
  account_id TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  category   TEXT    NOT NULL DEFAULT 'open',
  color      TEXT    NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  built_in   INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);

-- Attachments, content-addressed by SHA-256 (docs/02-architecture.md).
-- The hash IS the identity: pasting the same screenshot into two todos stores
-- one copy, and Phase 2's sync channel can ask for bytes by name without any
-- coordination. The body only ever carries `![](attachment:<hash>)`.
CREATE TABLE IF NOT EXISTS blob (
  account_id TEXT    NOT NULL,
  hash       TEXT    NOT NULL,
  mime       TEXT    NOT NULL DEFAULT '',
  bytes      BLOB    NOT NULL,
  byte_size  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, hash)
);

-- Axis 1: Collections — named, nestable, the future unit of sharing.
CREATE TABLE IF NOT EXISTS collection (
  account_id TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  parent_id  TEXT,
  owner_id   TEXT    NOT NULL DEFAULT '',
  color      TEXT    NOT NULL DEFAULT '',
  icon       TEXT    NOT NULL DEFAULT '',
  order_key  TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  tombstone  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);

-- Many-to-many, tombstoned: a node lives in zero or more Collections.
CREATE TABLE IF NOT EXISTS node_collection (
  account_id    TEXT    NOT NULL,
  node_id       TEXT    NOT NULL,
  collection_id TEXT    NOT NULL,
  order_key     TEXT    NOT NULL DEFAULT '',
  tombstone     INTEGER NOT NULL DEFAULT 0,
  hlc           TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, node_id, collection_id)
);
CREATE INDEX IF NOT EXISTS node_collection_by_collection
  ON node_collection (account_id, collection_id, tombstone);

-- Axis 2: Tags — flat, cross-cutting personal labels.
CREATE TABLE IF NOT EXISTS tag (
  account_id TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT '',
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tag_by_name ON tag (account_id, name);

CREATE TABLE IF NOT EXISTS node_tag (
  account_id TEXT    NOT NULL,
  node_id    TEXT    NOT NULL,
  tag_id     TEXT    NOT NULL,
  added_at   INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  hlc        TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, node_id, tag_id)
);
CREATE INDEX IF NOT EXISTS node_tag_by_tag ON node_tag (account_id, tag_id, deleted);
"#;

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::*;
    use crate::CoreError;
    use std::cell::RefCell;

    fn map_err(e: rusqlite::Error) -> CoreError {
        CoreError::Store(e.to_string())
    }

    impl rusqlite::ToSql for SqlValue {
        fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
            use rusqlite::types::{ToSqlOutput, Value, ValueRef};
            Ok(match self {
                SqlValue::Null => ToSqlOutput::Borrowed(ValueRef::Null),
                SqlValue::Int(i) => ToSqlOutput::Owned(Value::Integer(*i)),
                SqlValue::Real(f) => ToSqlOutput::Owned(Value::Real(*f)),
                SqlValue::Text(s) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
                SqlValue::Blob(b) => ToSqlOutput::Borrowed(ValueRef::Blob(b)),
            })
        }
    }

    /// The native projection, used by the Tauri shell.
    ///
    /// `RefCell` rather than `&mut self`: the [`Store`] contract is `&self` so the
    /// wasm side can hold a JS callback, and `rusqlite::Connection` only needs
    /// `&self` for both execute and query anyway.
    pub struct SqliteStore {
        conn: RefCell<rusqlite::Connection>,
    }

    impl SqliteStore {
        /// Open (or create) the projection at `path`.
        pub fn open(path: &std::path::Path) -> Result<Self> {
            let conn = rusqlite::Connection::open(path).map_err(map_err)?;
            // WAL survives an unclean shutdown without losing committed work —
            // the Phase 1 criterion is "killing and relaunching loses nothing".
            conn.pragma_update(None, "journal_mode", "WAL")
                .map_err(map_err)?;
            conn.pragma_update(None, "synchronous", "NORMAL")
                .map_err(map_err)?;
            conn.pragma_update(None, "foreign_keys", "ON")
                .map_err(map_err)?;
            Ok(Self {
                conn: RefCell::new(conn),
            })
        }

        /// An in-memory projection — tests, and "rebuild from the log" flows.
        pub fn in_memory() -> Result<Self> {
            let conn = rusqlite::Connection::open_in_memory().map_err(map_err)?;
            Ok(Self {
                conn: RefCell::new(conn),
            })
        }
    }

    impl Store for SqliteStore {
        fn execute(&self, sql: &str, params: &[SqlValue]) -> Result<u64> {
            let conn = self.conn.borrow();
            let mut stmt = conn.prepare_cached(sql).map_err(map_err)?;
            let n = stmt
                .execute(rusqlite::params_from_iter(params.iter()))
                .map_err(map_err)?;
            Ok(n as u64)
        }

        fn execute_batch(&self, sql: &str) -> Result<()> {
            self.conn.borrow().execute_batch(sql).map_err(map_err)
        }

        fn query(&self, sql: &str, params: &[SqlValue]) -> Result<Vec<Row>> {
            let conn = self.conn.borrow();
            let mut stmt = conn.prepare_cached(sql).map_err(map_err)?;
            let column_count = stmt.column_count();
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                    let mut row: Row = Vec::with_capacity(column_count);
                    for i in 0..column_count {
                        row.push(match r.get_ref(i)? {
                            rusqlite::types::ValueRef::Null => SqlValue::Null,
                            rusqlite::types::ValueRef::Integer(v) => SqlValue::Int(v),
                            rusqlite::types::ValueRef::Real(v) => SqlValue::Real(v),
                            rusqlite::types::ValueRef::Text(v) => {
                                SqlValue::Text(String::from_utf8_lossy(v).into_owned())
                            }
                            rusqlite::types::ValueRef::Blob(v) => SqlValue::Blob(v.to_vec()),
                        });
                    }
                    Ok(row)
                })
                .map_err(map_err)?;

            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_err)
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::SqliteStore;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    fn store() -> SqliteStore {
        let s = SqliteStore::in_memory().unwrap();
        s.init_schema().unwrap();
        s
    }

    #[test]
    fn schema_init_is_idempotent() {
        let s = store();
        s.init_schema().unwrap();
        s.init_schema().unwrap();
    }

    #[test]
    fn values_round_trip_through_the_port() {
        let s = store();
        s.execute(
            "INSERT INTO node (account_id, id, title, order_key, due_at) VALUES (?, ?, ?, ?, ?)",
            &[
                "acct".into(),
                "n1".into(),
                "hello".into(),
                "V-dev".into(),
                SqlValue::Null,
            ],
        )
        .unwrap();

        let rows = s
            .query(
                "SELECT title, promoted, due_at FROM node WHERE account_id = ? AND id = ?",
                &["acct".into(), "n1".into()],
            )
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][0], SqlValue::Text("hello".into()));
        assert_eq!(rows[0][1], SqlValue::Int(0));
        assert!(rows[0][2].is_null());
    }

    #[test]
    fn a_failing_transaction_rolls_back() {
        // The event log must never record a change the projection did not make.
        let s = store();
        let result: Result<()> = s.transaction(|| {
            s.execute(
                "INSERT INTO node (account_id, id, title, order_key) VALUES (?, ?, ?, ?)",
                &["acct".into(), "n1".into(), "x".into(), "V-dev".into()],
            )?;
            Err(crate::CoreError::Store("deliberate failure".into()))
        });

        assert!(result.is_err());
        assert_eq!(
            s.query_i64("SELECT COUNT(*) FROM node", &[]).unwrap(),
            Some(0),
            "the failed transaction left a row behind"
        );
    }

    #[test]
    fn a_committed_transaction_persists() {
        let s = store();
        s.transaction(|| {
            s.execute(
                "INSERT INTO node (account_id, id, title, order_key) VALUES (?, ?, ?, ?)",
                &["acct".into(), "n1".into(), "x".into(), "V-dev".into()],
            )
        })
        .unwrap();
        assert_eq!(
            s.query_i64("SELECT COUNT(*) FROM node", &[]).unwrap(),
            Some(1)
        );
    }

    #[test]
    fn the_same_id_can_exist_under_two_accounts() {
        // Partitioning is by composite key, so ids never need to be globally
        // unique across hosts — which is what makes multi-host additive.
        let s = store();
        for account in ["acct-a", "acct-b"] {
            s.execute(
                "INSERT INTO node (account_id, id, title, order_key) VALUES (?, ?, ?, ?)",
                &[
                    account.into(),
                    "shared".into(),
                    account.into(),
                    "V-dev".into(),
                ],
            )
            .unwrap();
        }
        let rows = s
            .query(
                "SELECT title FROM node WHERE account_id = ? AND id = ?",
                &["acct-b".into(), "shared".into()],
            )
            .unwrap();
        assert_eq!(rows[0][0], SqlValue::Text("acct-b".into()));
    }
}
