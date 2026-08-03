//! The SQLite projection, and the one seam where the native and wasm32 builds
//! differ (docs/02-architecture.md §3).
//!
//! SQLite is a **deterministic projection** of the op log, never a primary. It is
//! queried, not authored, and is rebuildable from scratch.
//!
//! * **native** — [`SqliteStore`] over `rusqlite`, inside the Tauri shell.
//! * **wasm32** — the browser PWA implements [`Store`] against `sqlite-wasm` +
//!   OPFS in the host JS environment. `rusqlite` is not in the wasm dependency
//!   graph at all.
//!
//! Both run the *same* [`SCHEMA_SQL`], which is what makes the split a port rather
//! than a fork.
//!
//! **Phase 0 scope:** enough schema and API for the WASM spike to prove a real
//! write/read round-trip. The full projection lands in Phase 1.

use crate::Result;

/// The projection schema. Deliberately a plain `&str` so the wasm build can hand
/// it to `sqlite-wasm` verbatim.
///
/// Every table is account-scoped from day one (`account_id`) — multi-host is
/// additive rather than a migration (roadmap Phase 1 exit criterion).
pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS node (
  account_id   TEXT NOT NULL,
  id           TEXT NOT NULL,
  parent_id    TEXT,
  kind         TEXT NOT NULL DEFAULT 'task',
  promoted     INTEGER NOT NULL DEFAULT 0,
  title        TEXT NOT NULL DEFAULT '',
  body_md      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'inbox',
  order_key    TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0,
  due_at       INTEGER,
  completed_at INTEGER,
  deleted      INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER,
  hlc          TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS node_by_parent ON node (account_id, parent_id, order_key);

CREATE TABLE IF NOT EXISTS event (
  account_id  TEXT NOT NULL,
  id          TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  from_value  TEXT,
  to_value    TEXT,
  occurred_at TEXT NOT NULL,
  payload     TEXT,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS event_by_time ON event (account_id, occurred_at);
"#;

/// One projected NODE row, in the narrow shape Phase 0 needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRow {
    pub id: String,
    pub title: String,
    pub body_md: String,
    pub order_key: String,
    pub hlc: String,
}

/// The engine port's storage half. Implemented by `rusqlite` natively and by
/// `sqlite-wasm` + OPFS in the browser.
pub trait Store {
    /// Idempotent — safe on every boot.
    fn init_schema(&mut self) -> Result<()>;

    /// Insert or overwrite a projected node row.
    fn upsert_node(&mut self, account_id: &str, row: &NodeRow) -> Result<()>;

    fn load_node(&self, account_id: &str, id: &str) -> Result<Option<NodeRow>>;

    /// Live (non-tombstoned) node count for one account. Proves partitioning:
    /// another account's rows must never be counted here.
    fn count_nodes(&self, account_id: &str) -> Result<u64>;
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::*;
    use crate::CoreError;

    fn map_err(e: rusqlite::Error) -> CoreError {
        CoreError::Store(e.to_string())
    }

    /// The native projection, used by the Tauri shell.
    pub struct SqliteStore {
        conn: rusqlite::Connection,
    }

    impl SqliteStore {
        /// Open (or create) the projection at `path`.
        pub fn open(path: &std::path::Path) -> Result<Self> {
            let conn = rusqlite::Connection::open(path).map_err(map_err)?;
            Ok(Self { conn })
        }

        /// An in-memory projection — used by tests and by "rebuild from the op
        /// log" flows.
        pub fn in_memory() -> Result<Self> {
            let conn = rusqlite::Connection::open_in_memory().map_err(map_err)?;
            Ok(Self { conn })
        }
    }

    impl Store for SqliteStore {
        fn init_schema(&mut self) -> Result<()> {
            self.conn.execute_batch(SCHEMA_SQL).map_err(map_err)
        }

        fn upsert_node(&mut self, account_id: &str, row: &NodeRow) -> Result<()> {
            self.conn
                .execute(
                    "INSERT INTO node (account_id, id, title, body_md, order_key, hlc)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT (account_id, id) DO UPDATE SET
                       title = excluded.title,
                       body_md = excluded.body_md,
                       order_key = excluded.order_key,
                       hlc = excluded.hlc",
                    rusqlite::params![
                        account_id,
                        row.id,
                        row.title,
                        row.body_md,
                        row.order_key,
                        row.hlc
                    ],
                )
                .map(|_| ())
                .map_err(map_err)
        }

        fn load_node(&self, account_id: &str, id: &str) -> Result<Option<NodeRow>> {
            self.conn
                .query_row(
                    "SELECT id, title, body_md, order_key, hlc
                     FROM node WHERE account_id = ?1 AND id = ?2",
                    rusqlite::params![account_id, id],
                    |r| {
                        Ok(NodeRow {
                            id: r.get(0)?,
                            title: r.get(1)?,
                            body_md: r.get(2)?,
                            order_key: r.get(3)?,
                            hlc: r.get(4)?,
                        })
                    },
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(map_err(other)),
                })
        }

        fn count_nodes(&self, account_id: &str) -> Result<u64> {
            self.conn
                .query_row(
                    "SELECT COUNT(*) FROM node WHERE account_id = ?1 AND deleted = 0",
                    rusqlite::params![account_id],
                    |r| r.get::<_, i64>(0),
                )
                .map(|n| n as u64)
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
        let mut s = SqliteStore::in_memory().unwrap();
        s.init_schema().unwrap();
        s
    }

    fn row(id: &str) -> NodeRow {
        NodeRow {
            id: id.into(),
            title: "Ship EOD report".into(),
            body_md: "## Goal\nmarkdown body".into(),
            order_key: "V-dev-a".into(),
            hlc: "0000000000000001-00000000-dev-a".into(),
        }
    }

    #[test]
    fn schema_init_is_idempotent() {
        let mut s = store();
        s.init_schema().unwrap();
        s.init_schema().unwrap();
    }

    #[test]
    fn a_node_round_trips_through_the_projection() {
        let mut s = store();
        let r = row("node-1");
        s.upsert_node("acct-a", &r).unwrap();
        assert_eq!(s.load_node("acct-a", "node-1").unwrap(), Some(r));
    }

    #[test]
    fn upsert_overwrites_rather_than_duplicating() {
        let mut s = store();
        s.upsert_node("acct-a", &row("node-1")).unwrap();
        let mut updated = row("node-1");
        updated.title = "Renamed".into();
        s.upsert_node("acct-a", &updated).unwrap();

        assert_eq!(s.count_nodes("acct-a").unwrap(), 1);
        assert_eq!(
            s.load_node("acct-a", "node-1").unwrap().unwrap().title,
            "Renamed"
        );
    }

    #[test]
    fn accounts_are_partitioned() {
        // Roadmap Phase 1 exit criterion, enforced from the first schema: one
        // account's rows must be invisible to another.
        let mut s = store();
        s.upsert_node("acct-a", &row("node-1")).unwrap();
        s.upsert_node("acct-b", &row("node-2")).unwrap();

        assert_eq!(s.count_nodes("acct-a").unwrap(), 1);
        assert_eq!(s.count_nodes("acct-b").unwrap(), 1);
        assert_eq!(s.load_node("acct-b", "node-1").unwrap(), None);
    }

    #[test]
    fn the_same_id_can_exist_under_two_accounts() {
        let mut s = store();
        s.upsert_node("acct-a", &row("shared-id")).unwrap();
        let mut other = row("shared-id");
        other.title = "Different account".into();
        s.upsert_node("acct-b", &other).unwrap();

        assert_eq!(
            s.load_node("acct-a", "shared-id").unwrap().unwrap().title,
            "Ship EOD report"
        );
        assert_eq!(
            s.load_node("acct-b", "shared-id").unwrap().unwrap().title,
            "Different account"
        );
    }

    #[test]
    fn missing_rows_are_none_not_an_error() {
        let s = store();
        assert_eq!(s.load_node("acct-a", "nope").unwrap(), None);
    }
}
