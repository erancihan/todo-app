//! The Phase 1 engine — every decision Daybook makes about a node.
//!
//! This module is the payoff of the architecture: it is written **once**, against
//! the narrow [`Store`] port, and both targets run this exact code. The Tauri
//! shell reaches it over IPC and the browser reaches it as a WASM call, but
//! neither has its own copy of "what promote means" or "how order keys are
//! chosen". A behavioural divergence between desktop and browser would have to be
//! a bug in SQLite itself.
//!
//! Two invariants hold across every mutation:
//!
//! 1. **The event log is complete.** Every state change appends an [`EVENT`] in
//!    the same transaction as the change. The EOD report (Phase 3) is only
//!    deterministic if the log never missed anything.
//! 2. **Everything is account-scoped.** No query runs without an `account_id`
//!    filter, so a second account slots in without a migration.
//!
//! [`EVENT`]: crate::event::Event

use std::cell::RefCell;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::b64;
use crate::body::{BodyCrdt, BodyUpdate, YrsBody};
use crate::event::EventType;
use crate::hlc::{Hlc, HlcClock};
use crate::ids::{new_id, DeviceId};
use crate::node::{Kind, StatusCategory, MAX_DEPTH};
use crate::order_key;
use crate::store::{SqlValue, Store, StoreExt};
use crate::{CoreError, Result};

/// A node as the UI consumes it: the row, plus the derived bits a list needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: Kind,
    pub promoted: bool,
    pub title: String,
    pub body_md: String,
    /// The id of a user-defined status row.
    pub status: String,
    /// The status's semantic, resolved at read time so the UI and the report
    /// never have to join the status table themselves.
    pub status_category: StatusCategory,
    pub order_key: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub due_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub collapsed: bool,
    /// Depth in the tree, 0 for a root todo. Derived, not stored.
    pub depth: usize,
    pub has_children: bool,
    pub tags: Vec<TagView>,
    pub collection_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagView {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionView {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: String,
    pub icon: String,
    /// Live (non-tombstoned, non-deleted) member count.
    pub node_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub id: String,
    pub node_id: String,
    pub r#type: String,
    pub from_value: Option<String>,
    pub to_value: Option<String>,
    pub occurred_at: String,
    pub occurred_ms: i64,
}

/// One user-defined status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub id: String,
    pub name: String,
    pub category: StatusCategory,
    pub color: String,
    pub sort: i64,
    pub built_in: bool,
}

/// An attachment with its bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobView {
    pub hash: String,
    pub mime: String,
    #[serde(with = "crate::b64::serde_bytes")]
    pub bytes: Vec<u8>,
    pub byte_size: i64,
}

/// An attachment without them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobMeta {
    pub hash: String,
    pub mime: String,
    pub byte_size: i64,
    pub created_at: i64,
}

/// The 8 muted hues (docs/04-ux-and-interaction.md §7.1), assigned round-robin so
/// a new tag or collection gets a stable colour without asking the user to pick
/// one. Assigned here rather than derived in the UI so the colour is durable: it
/// survives a reload and is the same on every host.
const HUES: [&str; 8] = [
    "slate", "rose", "amber", "pink", "emerald", "cyan", "violet", "lime",
];

/// Columns every node query selects, in a fixed order. One constant so the
/// `SELECT` and the row decoder can never drift apart.
const NODE_COLUMNS: &str = "id, parent_id, kind, promoted, title, body_md, status, \
     order_key, created_at, updated_at, due_at, completed_at, collapsed";

pub struct Engine<S: Store> {
    store: S,
    account_id: String,
    device: DeviceId,
    clock: RefCell<HlcClock>,
}

impl<S: Store> Engine<S> {
    /// Open an engine over `store`, applying the schema if needed.
    pub fn open(store: S, account_id: impl Into<String>, device: DeviceId) -> Result<Self> {
        store.init_schema()?;
        let engine = Self {
            store,
            account_id: account_id.into(),
            clock: RefCell::new(HlcClock::new(device.clone())),
            device,
        };
        engine.seed_statuses()?;
        Ok(engine)
    }

    /// First run for an account: install the default status set.
    ///
    /// The built-in ids equal the old hard-coded enum strings, which is what
    /// makes this a zero-migration change — every `node.status` value written
    /// before statuses were data already names a seeded row. Seeding checks for
    /// *any* row (deleted included), so a user who removes a built-in does not
    /// get it resurrected on the next launch.
    fn seed_statuses(&self) -> Result<()> {
        let existing = self
            .store
            .query_i64(
                "SELECT COUNT(*) FROM status WHERE account_id = ?",
                &[self.account()],
            )?
            .unwrap_or(0);
        if existing > 0 {
            return Ok(());
        }

        // Both "Waiting" and "Blocked" ship: which of them (or neither, or both)
        // survives is a user decision, and deleting is easier than inventing.
        let seed: [(&str, &str, StatusCategory, &str); 6] = [
            ("todo", "Todo", StatusCategory::Open, ""),
            ("in_progress", "In progress", StatusCategory::Open, "amber"),
            ("waiting", "Waiting", StatusCategory::Open, "violet"),
            ("blocked", "Blocked", StatusCategory::Open, "rose"),
            ("done", "Done", StatusCategory::Done, "emerald"),
            ("dropped", "Dropped", StatusCategory::Cancelled, "slate"),
        ];
        for (sort, (id, name, category, color)) in seed.iter().enumerate() {
            self.store.execute(
                "INSERT INTO status (account_id, id, name, category, color, sort, built_in) \
                 VALUES (?, ?, ?, ?, ?, ?, 1)",
                &[
                    self.account(),
                    (*id).into(),
                    (*name).into(),
                    category.as_str().into(),
                    (*color).into(),
                    (sort as i64).into(),
                ],
            )?;
        }
        Ok(())
    }

    // -- statuses ------------------------------------------------------------

    /// Every live status, in sort order.
    pub fn list_statuses(&self) -> Result<Vec<StatusView>> {
        let rows = self.store.query(
            "SELECT id, name, category, color, sort, built_in FROM status \
             WHERE account_id = ? AND deleted = 0 ORDER BY sort, name",
            &[self.account()],
        )?;
        Ok(rows
            .iter()
            .map(|r| StatusView {
                id: r[0].text_or_default(),
                name: r[1].text_or_default(),
                category: StatusCategory::parse(&r[2].text_or_default()),
                color: r[3].text_or_default(),
                sort: r[4].as_i64().unwrap_or(0),
                built_in: r[5].as_i64().unwrap_or(0) != 0,
            })
            .collect())
    }

    /// `status id -> category` for every status ever created, deleted included.
    ///
    /// Deleted ones stay resolvable because nodes written before a deletion (or
    /// arriving later over sync) may still carry the id; an unknown id reads as
    /// `Open`, which is the degradation that never hides work.
    fn status_categories(&self) -> Result<HashMap<String, StatusCategory>> {
        let rows = self.store.query(
            "SELECT id, category FROM status WHERE account_id = ?",
            &[self.account()],
        )?;
        Ok(rows
            .iter()
            .map(|r| {
                (
                    r[0].text_or_default(),
                    StatusCategory::parse(&r[1].text_or_default()),
                )
            })
            .collect())
    }

    /// The status `x` lands on within a category — the lowest-sorted live one.
    fn default_status(&self, category: StatusCategory) -> Result<String> {
        let rows = self.store.query(
            "SELECT id FROM status WHERE account_id = ? AND deleted = 0 AND category = ? \
             ORDER BY sort, name LIMIT 1",
            &[self.account(), category.as_str().into()],
        )?;
        rows.first()
            .map(|r| r[0].text_or_default())
            .ok_or_else(|| CoreError::Store(format!("no {} status exists", category.as_str())))
    }

    /// The id `x` reopens to — public so the report can mute the default status.
    pub fn default_open_status_id(&self) -> Result<String> {
        self.default_status(StatusCategory::Open)
    }

    /// Add a status. The color is picked round-robin like tags when not given.
    pub fn create_status(
        &self,
        name: &str,
        category: StatusCategory,
        color: Option<&str>,
    ) -> Result<StatusView> {
        let name = name.trim();
        if name.is_empty() {
            return Err(CoreError::Store("status name cannot be empty".into()));
        }
        let id = new_id().to_string();
        let count = self
            .store
            .query_i64(
                "SELECT COUNT(*) FROM status WHERE account_id = ?",
                &[self.account()],
            )?
            .unwrap_or(0);
        let color = color
            .map(str::to_owned)
            .unwrap_or_else(|| HUES[count as usize % HUES.len()].to_owned());
        let sort = self
            .store
            .query_i64(
                "SELECT COALESCE(MAX(sort), -1) + 1 FROM status WHERE account_id = ?",
                &[self.account()],
            )?
            .unwrap_or(0);
        self.store.execute(
            "INSERT INTO status (account_id, id, name, category, color, sort, built_in) \
             VALUES (?, ?, ?, ?, ?, ?, 0)",
            &[
                self.account(),
                id.as_str().into(),
                name.into(),
                category.as_str().into(),
                color.as_str().into(),
                sort.into(),
            ],
        )?;
        Ok(StatusView {
            id,
            name: name.to_owned(),
            category,
            color,
            sort,
            built_in: false,
        })
    }

    pub fn rename_status(&self, id: &str, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(CoreError::Store("status name cannot be empty".into()));
        }
        self.store.execute(
            "UPDATE status SET name = ? WHERE account_id = ? AND id = ? AND deleted = 0",
            &[name.into(), self.account(), id.into()],
        )?;
        Ok(())
    }

    pub fn set_status_color(&self, id: &str, color: &str) -> Result<()> {
        self.store.execute(
            "UPDATE status SET color = ? WHERE account_id = ? AND id = ?",
            &[color.into(), self.account(), id.into()],
        )?;
        Ok(())
    }

    /// Remove a status, reassigning its nodes to the category default.
    ///
    /// Refused when it would leave no `Open` or no `Done` status — `x` needs a
    /// landing place in both directions. The row is tombstoned rather than
    /// erased so ids arriving over Phase 2 sync still resolve to a category.
    pub fn delete_status(&self, id: &str) -> Result<()> {
        let statuses = self.list_statuses()?;
        let Some(doomed) = statuses.iter().find(|s| s.id == id) else {
            return Err(CoreError::Store(format!("no such status: {id}")));
        };
        let survivors = |cat: StatusCategory| {
            statuses
                .iter()
                .filter(|s| s.category == cat && s.id != id)
                .count()
        };
        if (doomed.category == StatusCategory::Open && survivors(StatusCategory::Open) == 0)
            || (doomed.category == StatusCategory::Done && survivors(StatusCategory::Done) == 0)
        {
            return Err(CoreError::Store(
                "cannot delete the last open or done status".into(),
            ));
        }

        self.store.transaction(|| {
            self.store.execute(
                "UPDATE status SET deleted = 1 WHERE account_id = ? AND id = ?",
                &[self.account(), id.into()],
            )?;
            // Reassign in place, without per-node events: this is an admin
            // reshaping of vocabulary, not a day of activity, and a thousand
            // `updated` events here would drown the EOD report in noise.
            let fallback = self.default_status(match doomed.category {
                StatusCategory::Done => StatusCategory::Done,
                _ => StatusCategory::Open,
            })?;
            self.store.execute(
                "UPDATE node SET status = ? WHERE account_id = ? AND status = ?",
                &[fallback.as_str().into(), self.account(), id.into()],
            )?;
            Ok(())
        })
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    /// Take the store back — lets a test reopen the same database as a fresh
    /// engine, which is how "state survives a relaunch" is provable in-memory.
    pub fn into_store(self) -> S {
        self.store
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    fn account(&self) -> SqlValue {
        self.account_id.as_str().into()
    }

    fn now_ms(&self) -> i64 {
        self.clock.borrow_mut().now().wall_ms as i64
    }

    /// One HLC reading, to be shared by everything a single operation writes.
    ///
    /// Reading the clock separately for the row and for its event let the two
    /// land a millisecond apart, so a node's `updated_at` and the `occurred_ms`
    /// of the event that caused it disagreed. Anything correlating the tree with
    /// the log then saw one moment as two — the EOD report's "touched before this
    /// range" test flickered on exactly that.
    fn stamp(&self) -> Hlc {
        self.clock.borrow_mut().now()
    }

    /// Stamp and append an event. Called inside the caller's transaction, never
    /// on its own — a change and its event commit together or not at all, and
    /// carry the same timestamp.
    fn emit(
        &self,
        at: &Hlc,
        node_id: &str,
        kind: EventType,
        from: Option<&str>,
        to: Option<&str>,
        payload: Option<&str>,
    ) -> Result<()> {
        let hlc = at;
        let type_str = serde_json::to_value(kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "updated".into());

        self.store.execute(
            "INSERT INTO event (account_id, id, node_id, actor_id, type, from_value, to_value, \
             occurred_at, occurred_ms, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                self.account(),
                new_id().to_string().into(),
                node_id.into(),
                self.device.as_str().into(),
                type_str.into(),
                from.map(str::to_owned).into(),
                to.map(str::to_owned).into(),
                hlc.to_string().into(),
                (hlc.wall_ms as i64).into(),
                payload.map(str::to_owned).into(),
            ],
        )?;
        Ok(())
    }

    fn touch(&self, node_id: &str, hlc: &Hlc) -> Result<()> {
        self.store.execute(
            "UPDATE node SET updated_at = ?, hlc = ? WHERE account_id = ? AND id = ?",
            &[
                (hlc.wall_ms as i64).into(),
                hlc.to_string().into(),
                self.account(),
                node_id.into(),
            ],
        )?;
        Ok(())
    }

    // -- ordering ----------------------------------------------------------

    /// Order key for a new or moved node placed directly after `after` among
    /// `parent`'s children. `after == None` means "first".
    fn order_key_between(&self, parent: Option<&str>, after: Option<&str>) -> Result<String> {
        let siblings = self.sibling_keys(parent)?;

        let (lower, upper) = match after {
            None => (None, siblings.first().map(|(_, k)| k.clone())),
            Some(after_id) => {
                let index = siblings.iter().position(|(id, _)| id == after_id);
                match index {
                    Some(i) => (
                        Some(siblings[i].1.clone()),
                        siblings.get(i + 1).map(|(_, k)| k.clone()),
                    ),
                    // `after` is not actually a sibling (stale UI state) — append
                    // rather than fail; the user's intent was "at the end-ish".
                    None => (siblings.last().map(|(_, k)| k.clone()), None),
                }
            }
        };

        Ok(order_key::between(
            lower.as_deref(),
            upper.as_deref(),
            &self.device,
        ))
    }

    fn sibling_keys(&self, parent: Option<&str>) -> Result<Vec<(String, String)>> {
        let rows = match parent {
            Some(p) => self.store.query(
                "SELECT id, order_key FROM node WHERE account_id = ? AND parent_id = ? \
                 AND deleted = 0 ORDER BY order_key",
                &[self.account(), p.into()],
            )?,
            None => self.store.query(
                "SELECT id, order_key FROM node WHERE account_id = ? AND parent_id IS NULL \
                 AND deleted = 0 ORDER BY order_key",
                &[self.account()],
            )?,
        };
        Ok(rows
            .into_iter()
            .map(|r| (r[0].text_or_default(), r[1].text_or_default()))
            .collect())
    }

    // -- nodes -------------------------------------------------------------

    /// Create a node and emit `created`.
    ///
    /// `after` positions it among `parent`'s children; `None` puts it first.
    pub fn create_node(
        &self,
        parent_id: Option<&str>,
        title: &str,
        after: Option<&str>,
    ) -> Result<NodeView> {
        let at = self.stamp();
        if let Some(parent) = parent_id {
            let depth = self.depth_of(parent)?;
            if depth + 1 >= MAX_DEPTH {
                return Err(CoreError::Store(format!(
                    "cannot nest deeper than {MAX_DEPTH} levels"
                )));
            }
        }

        let id = new_id().to_string();
        let order_key = self.order_key_between(parent_id, after)?;
        let now = at.wall_ms as i64;
        let hlc = at.to_string();
        // A child starts life as a checklist item; a root starts as a full task.
        let kind = if parent_id.is_some() {
            Kind::ChecklistItem
        } else {
            Kind::Task
        };

        self.store.transaction(|| {
            self.store.execute(
                "INSERT INTO node (account_id, id, parent_id, kind, title, status, order_key, \
                 created_at, updated_at, hlc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    self.account(),
                    id.as_str().into(),
                    parent_id.map(str::to_owned).into(),
                    kind.as_str().into(),
                    title.into(),
                    self.default_status(StatusCategory::Open)?.as_str().into(),
                    order_key.as_str().into(),
                    now.into(),
                    now.into(),
                    hlc.as_str().into(),
                ],
            )?;
            self.emit(&at, &id, EventType::Created, None, Some(title), None)
        })?;

        self.node(&id)?
            .ok_or_else(|| CoreError::Store("node vanished after create".into()))
    }

    /// One node, or `None` if it does not exist or is tombstoned.
    pub fn node(&self, id: &str) -> Result<Option<NodeView>> {
        let Some(row) = self.store.query_one(
            &format!(
                "SELECT {NODE_COLUMNS} FROM node WHERE account_id = ? AND id = ? AND deleted = 0"
            ),
            &[self.account(), id.into()],
        )?
        else {
            return Ok(None);
        };

        let mut view = decode_node(&row, 0, &self.status_categories()?);
        view.has_children = self
            .store
            .query_i64(
                "SELECT COUNT(*) FROM node WHERE account_id = ? AND parent_id = ? AND deleted = 0",
                &[self.account(), id.into()],
            )?
            .unwrap_or(0)
            > 0;
        view.tags = self.tags_for(id)?;
        view.collection_ids = self.collections_for(id)?;
        Ok(Some(view))
    }

    /// The whole live tree, flattened depth-first in document order with `depth`
    /// filled in — exactly the order the list renders and `j`/`k` traverse.
    ///
    /// One query for nodes plus one each for tags and memberships, assembled in
    /// memory. At Phase 1 scale that beats a recursive CTE for readability, and
    /// the shape stays the same if it later needs to become one.
    pub fn list_tree(&self) -> Result<Vec<NodeView>> {
        let rows = self.store.query(
            &format!(
                "SELECT {NODE_COLUMNS} FROM node WHERE account_id = ? AND deleted = 0 \
                 ORDER BY order_key"
            ),
            &[self.account()],
        )?;

        let categories = self.status_categories()?;
        let mut by_parent: HashMap<Option<String>, Vec<NodeView>> = HashMap::new();
        for row in &rows {
            let view = decode_node(row, 0, &categories);
            by_parent
                .entry(view.parent_id.clone())
                .or_default()
                .push(view);
        }
        // The SELECT is already ordered, but grouping does not preserve that
        // guarantee across parents; sort each sibling list explicitly.
        for children in by_parent.values_mut() {
            children.sort_by(|a, b| a.order_key.cmp(&b.order_key));
        }

        let mut tags = self.all_tags_by_node()?;
        let mut collections = self.all_collections_by_node()?;

        let mut out = Vec::with_capacity(rows.len());
        flatten(
            &by_parent,
            None,
            0,
            &mut out,
            &mut tags,
            &mut collections,
            &mut Vec::new(),
        );
        Ok(out)
    }

    fn depth_of(&self, id: &str) -> Result<usize> {
        let mut depth = 0;
        let mut current = id.to_owned();
        // Bounded by MAX_DEPTH + 1 so a cycle introduced by a bad write cannot
        // hang the UI; it reports too-deep instead.
        for _ in 0..=MAX_DEPTH {
            let parent = self.store.query_one(
                "SELECT parent_id FROM node WHERE account_id = ? AND id = ?",
                &[self.account(), current.as_str().into()],
            )?;
            match parent.as_ref().and_then(|r| r[0].as_str()) {
                Some(p) => {
                    depth += 1;
                    current = p.to_owned();
                }
                None => return Ok(depth),
            }
        }
        Err(CoreError::Store(
            "node tree is deeper than the cap, or cyclic".into(),
        ))
    }

    /// True when `candidate_parent` is `id` or sits beneath it — the check that
    /// stops a move from detaching a subtree into a cycle.
    fn would_cycle(&self, id: &str, candidate_parent: &str) -> Result<bool> {
        if id == candidate_parent {
            return Ok(true);
        }
        let mut current = candidate_parent.to_owned();
        for _ in 0..=MAX_DEPTH {
            let parent = self.store.query_one(
                "SELECT parent_id FROM node WHERE account_id = ? AND id = ?",
                &[self.account(), current.as_str().into()],
            )?;
            match parent.as_ref().and_then(|r| r[0].as_str()) {
                Some(p) if p == id => return Ok(true),
                Some(p) => current = p.to_owned(),
                None => return Ok(false),
            }
        }
        Ok(true)
    }

    /// Set or clear a due date, as UTC milliseconds.
    ///
    /// The host resolves "end of Friday" to an instant, the same way it resolves
    /// the report's day window — core does not own a timezone.
    pub fn set_due(&self, id: &str, due_ms: Option<i64>) -> Result<()> {
        let at = self.stamp();
        let previous = self.node(id)?.and_then(|n| n.due_at);
        if previous == due_ms {
            return Ok(());
        }
        self.store.transaction(|| {
            self.store.execute(
                "UPDATE node SET due_at = ? WHERE account_id = ? AND id = ?",
                &[due_ms.into(), self.account(), id.into()],
            )?;
            self.touch(id, &at)?;
            self.emit(
                &at,
                id,
                EventType::Updated,
                previous.map(|p| p.to_string()).as_deref(),
                due_ms.map(|d| d.to_string()).as_deref(),
                Some("due"),
            )
        })
    }

    pub fn set_title(&self, id: &str, title: &str) -> Result<()> {
        let at = self.stamp();
        let previous = self.node(id)?.map(|n| n.title).unwrap_or_default();
        if previous == title {
            return Ok(());
        }
        self.store.transaction(|| {
            self.store.execute(
                "UPDATE node SET title = ? WHERE account_id = ? AND id = ?",
                &[title.into(), self.account(), id.into()],
            )?;
            self.touch(id, &at)?;
            self.emit(
                &at,
                id,
                EventType::Updated,
                Some(&previous),
                Some(title),
                None,
            )
        })
    }

    /// Replace a body's text, routing the change through the `Y.Text` CRDT rather
    /// than overwriting the column.
    ///
    /// The editor hands us a whole new string, but storing that directly would
    /// throw away the CRDT history and make Phase 2 merges meaningless. So we diff
    /// against the current text and apply the minimal splice — which is what the
    /// user actually did, and what a peer needs to merge correctly.
    pub fn set_body(&self, id: &str, markdown: &str) -> Result<()> {
        let at = self.stamp();
        let Some(row) = self.store.query_one(
            "SELECT body_md, body_state, title FROM node \
             WHERE account_id = ? AND id = ? AND deleted = 0",
            &[self.account(), id.into()],
        )?
        else {
            return Err(CoreError::Store(format!("no such node: {id}")));
        };

        let current = row[0].text_or_default();
        if current == markdown {
            return Ok(());
        }
        let previous_title = row[2].text_or_default();

        let mut body = load_body(&row[1].text_or_default(), self.body_client_id())?;
        apply_text_change(&mut body, markdown)?;
        let state = b64::encode(body.snapshot()?.as_bytes());
        let text = body.text();

        // Capture is zero-ceremony: the user types prose and never fills in a
        // title field (docs/04 §1). So the title is *derived* from the body's
        // first meaningful line — that is what the list row shows and what the
        // EOD report will use for its bullets.
        //
        // `title` is still an independently settable LWW field though, so a title
        // someone set deliberately must survive later body edits. The test for
        // "still automatic" is whether the stored title matches what the *old*
        // body would have derived: if so it was ours to maintain, otherwise
        // someone set it by hand and we leave it alone.
        let title_is_derived =
            previous_title.is_empty() || previous_title == derive_title(&current);
        let next_title = derive_title(&text);
        let retitle = title_is_derived && next_title != previous_title;

        self.store.transaction(|| {
            self.store.execute(
                "UPDATE node SET body_md = ?, body_state = ? WHERE account_id = ? AND id = ?",
                &[
                    text.as_str().into(),
                    state.as_str().into(),
                    self.account(),
                    id.into(),
                ],
            )?;
            if retitle {
                self.store.execute(
                    "UPDATE node SET title = ? WHERE account_id = ? AND id = ?",
                    &[next_title.as_str().into(), self.account(), id.into()],
                )?;
            }
            self.touch(id, &at)?;
            // Bodies change constantly while typing; the log records that the body
            // changed, not every keystroke's before/after.
            self.emit(
                &at,
                id,
                EventType::Updated,
                None,
                None,
                Some(r#"{"field":"body_md"}"#),
            )
        })
    }

    /// A stable per-device CRDT client id, derived from the device id.
    fn body_client_id(&self) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in self.device.as_str().bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash & ((1u64 << 53) - 1)
    }

    pub fn set_status(&self, id: &str, status_id: &str) -> Result<()> {
        let at = self.stamp();
        let Some(node) = self.node(id)? else {
            return Err(CoreError::Store(format!("no such node: {id}")));
        };
        if node.status == status_id {
            return Ok(());
        }
        let statuses = self.status_categories()?;
        let Some(&category) = statuses.get(status_id) else {
            return Err(CoreError::Store(format!("no such status: {status_id}")));
        };
        let was_done = node.status_category == StatusCategory::Done;
        let is_done = category == StatusCategory::Done;

        let now = at.wall_ms as i64;
        let completed_at: SqlValue = if is_done { now.into() } else { SqlValue::Null };

        self.store.transaction(|| {
            self.store.execute(
                "UPDATE node SET status = ?, completed_at = ? WHERE account_id = ? AND id = ?",
                &[
                    status_id.into(),
                    completed_at.clone(),
                    self.account(),
                    id.into(),
                ],
            )?;
            self.touch(id, &at)?;

            // Three distinct event types, because the report reads them
            // differently: `completed` is an accomplishment, `reopened` undoes
            // one, and a move between open states is just progress. Category,
            // not id, decides which — renaming "Done" must not change what
            // finishing a task means.
            let kind = if is_done && !was_done {
                EventType::Completed
            } else if was_done && !is_done {
                EventType::Reopened
            } else {
                EventType::StatusChanged
            };
            self.emit(&at, id, kind, Some(&node.status), Some(status_id), None)
        })
    }

    /// `x` — flip between the default done and default open status.
    pub fn toggle_done(&self, id: &str) -> Result<()> {
        let Some(node) = self.node(id)? else {
            return Err(CoreError::Store(format!("no such node: {id}")));
        };
        let target = if node.status_category == StatusCategory::Done {
            self.default_status(StatusCategory::Open)?
        } else {
            self.default_status(StatusCategory::Done)?
        };
        self.set_status(id, &target)
    }

    /// `p` — promote a sub-item to a full todo **in place**.
    ///
    /// No row copy and `parent_id` is untouched: the node keeps its identity and
    /// its place in the tree, and simply gains the capabilities of a full todo
    /// (docs/03-data-model.md §6).
    pub fn promote(&self, id: &str) -> Result<()> {
        let at = self.stamp();
        let Some(node) = self.node(id)? else {
            return Err(CoreError::Store(format!("no such node: {id}")));
        };
        if node.promoted {
            return Ok(());
        }
        self.store.transaction(|| {
            self.store.execute(
                "UPDATE node SET promoted = 1, kind = ? WHERE account_id = ? AND id = ?",
                &[Kind::Task.as_str().into(), self.account(), id.into()],
            )?;
            self.touch(id, &at)?;
            self.emit(&at, id, EventType::Promoted, None, None, None)
        })
    }

    /// Deep-copy a node and everything under it, placing the copy after `after`
    /// among `new_parent`'s children.
    ///
    /// Backs `y`/`P` (yank and paste). The copy is a genuinely new node: fresh
    /// ids, fresh `created` events, and a fresh `Y.Text` body seeded with the
    /// original's *text* rather than its CRDT state.
    ///
    /// Seeding from text is not a correctness requirement — each node's body is
    /// its own Yjs document, and Yjs only needs client ids unique *within* a
    /// document, so two nodes may legitimately hold byte-identical state. It is a
    /// hygiene choice: the copy starts with a clean, minimal history instead of
    /// inheriting the original's edits and tombstones.
    ///
    /// Tags and collection memberships come along; completion does not — a pasted
    /// copy is work still to do, not work already done.
    pub fn duplicate_node(
        &self,
        id: &str,
        new_parent: Option<&str>,
        after: Option<&str>,
    ) -> Result<NodeView> {
        let Some(source) = self.node(id)? else {
            return Err(CoreError::Store(format!("no such node: {id}")));
        };

        let copy = self.create_node(new_parent, &source.title, after)?;
        if !source.body_md.is_empty() {
            self.set_body(&copy.id, &source.body_md)?;
        }
        if source.promoted {
            self.promote(&copy.id)?;
        }
        for tag in &source.tags {
            self.add_tag(&copy.id, &tag.name)?;
        }
        for collection in &source.collection_ids {
            self.add_to_collection(&copy.id, collection)?;
        }

        // Children in document order, each appended after the previous copy so
        // the subtree keeps its shape.
        let mut previous: Option<String> = None;
        for (child, _) in self.sibling_keys(Some(id))? {
            let child_copy = self.duplicate_node(&child, Some(&copy.id), previous.as_deref())?;
            previous = Some(child_copy.id);
        }

        self.node(&copy.id)?
            .ok_or_else(|| CoreError::Store("copy vanished after create".into()))
    }

    /// Reverse a promotion.
    ///
    /// Discouraged in normal use — the data model says the event trail is the
    /// record and demotion is rare — but undo needs it, and an undo that cannot
    /// reverse the last action is not undo.
    pub fn demote(&self, id: &str) -> Result<()> {
        let at = self.stamp();
        let Some(node) = self.node(id)? else {
            return Err(CoreError::Store(format!("no such node: {id}")));
        };
        if !node.promoted {
            return Ok(());
        }
        // A node with a parent goes back to being a checklist item; a root node
        // was always a task and stays one.
        let kind = if node.parent_id.is_some() {
            Kind::ChecklistItem
        } else {
            Kind::Task
        };
        self.store.transaction(|| {
            self.store.execute(
                "UPDATE node SET promoted = 0, kind = ? WHERE account_id = ? AND id = ?",
                &[kind.as_str().into(), self.account(), id.into()],
            )?;
            self.touch(id, &at)?;
            self.emit(
                &at,
                id,
                EventType::Updated,
                Some("promoted"),
                None,
                Some(r#"{"field":"promoted","to":false}"#),
            )
        })
    }

    /// Lift a tombstone, restoring a node and its subtree.
    ///
    /// Only safe as the inverse of a *local* delete that has not yet synced:
    /// once a delete has propagated, a tombstone is terminal by design
    /// (docs/03-data-model.md §5.4) and resurrecting it would fight the merge
    /// rules. Phase 2 must gate this on the causal watermark.
    pub fn restore_node(&self, id: &str) -> Result<usize> {
        let at = self.stamp();
        let mut restored = vec![id.to_owned()];
        let mut cursor = 0;
        while cursor < restored.len() {
            let children = self.store.query(
                "SELECT id FROM node WHERE account_id = ? AND parent_id = ? AND deleted = 1",
                &[self.account(), restored[cursor].as_str().into()],
            )?;
            for row in children {
                restored.push(row[0].text_or_default());
            }
            cursor += 1;
        }

        self.store.transaction(|| {
            for node_id in &restored {
                self.store.execute(
                    "UPDATE node SET deleted = 0, deleted_at = NULL \
                     WHERE account_id = ? AND id = ?",
                    &[self.account(), node_id.as_str().into()],
                )?;
                self.emit(
                    &at,
                    node_id,
                    EventType::Updated,
                    None,
                    None,
                    Some(r#"{"deleted":false}"#),
                )?;
            }
            Ok(())
        })?;
        Ok(restored.len())
    }

    /// `Tab` — become a child of the previous sibling.
    pub fn indent(&self, id: &str) -> Result<()> {
        let Some(node) = self.node(id)? else {
            return Err(CoreError::Store(format!("no such node: {id}")));
        };
        let siblings = self.sibling_keys(node.parent_id.as_deref())?;
        let Some(index) = siblings.iter().position(|(sid, _)| sid == id) else {
            return Ok(());
        };
        // Nothing above it at this level, so there is nothing to indent under.
        let Some((new_parent, _)) = index.checked_sub(1).and_then(|i| siblings.get(i)) else {
            return Ok(());
        };

        let last_child = self
            .sibling_keys(Some(new_parent))?
            .last()
            .map(|(cid, _)| cid.clone());
        self.move_node(id, Some(new_parent), last_child.as_deref())
    }

    /// `Shift+Tab` — become a sibling of the current parent, just after it.
    pub fn outdent(&self, id: &str) -> Result<()> {
        let Some(node) = self.node(id)? else {
            return Err(CoreError::Store(format!("no such node: {id}")));
        };
        let Some(parent_id) = node.parent_id.clone() else {
            return Ok(()); // already at root
        };
        let grandparent = self
            .store
            .query_one(
                "SELECT parent_id FROM node WHERE account_id = ? AND id = ?",
                &[self.account(), parent_id.as_str().into()],
            )?
            .and_then(|r| r[0].as_str().map(str::to_owned));

        self.move_node(id, grandparent.as_deref(), Some(&parent_id))
    }

    /// Reparent and/or reposition a node. One `order_key` is written; no reindex.
    pub fn move_node(&self, id: &str, new_parent: Option<&str>, after: Option<&str>) -> Result<()> {
        let at = self.stamp();
        if let Some(parent) = new_parent {
            if self.would_cycle(id, parent)? {
                return Err(CoreError::Store(
                    "refusing to move a node beneath itself".into(),
                ));
            }
            let subtree = self.subtree_height(id)?;
            if self.depth_of(parent)? + 1 + subtree >= MAX_DEPTH {
                return Err(CoreError::Store(format!(
                    "move would nest deeper than {MAX_DEPTH} levels"
                )));
            }
        }

        let order_key = self.order_key_between(new_parent, after)?;
        self.store.transaction(|| {
            self.store.execute(
                "UPDATE node SET parent_id = ?, order_key = ? WHERE account_id = ? AND id = ?",
                &[
                    new_parent.map(str::to_owned).into(),
                    order_key.as_str().into(),
                    self.account(),
                    id.into(),
                ],
            )?;
            self.touch(id, &at)?;
            self.emit(
                &at,
                id,
                EventType::Updated,
                None,
                None,
                Some(r#"{"field":"parent_id"}"#),
            )
        })
    }

    /// How many levels of descendants sit below `id`.
    fn subtree_height(&self, id: &str) -> Result<usize> {
        let children = self.sibling_keys(Some(id))?;
        let mut tallest = 0;
        for (child, _) in children {
            tallest = tallest.max(1 + self.subtree_height(&child)?);
            if tallest >= MAX_DEPTH {
                break;
            }
        }
        Ok(tallest)
    }

    /// Soft-delete a node and everything beneath it.
    ///
    /// The subtree goes too — otherwise the children become unreachable orphans
    /// that still count in queries. Every one gets its own tombstone and event, so
    /// the delete propagates properly in Phase 2 rather than relying on a peer
    /// re-deriving the cascade.
    pub fn delete_node(&self, id: &str) -> Result<usize> {
        let at = self.stamp();
        let mut doomed = vec![id.to_owned()];
        let mut cursor = 0;
        while cursor < doomed.len() {
            for (child, _) in self.sibling_keys(Some(&doomed[cursor]))? {
                doomed.push(child);
            }
            cursor += 1;
        }

        let now = at.wall_ms as i64;
        self.store.transaction(|| {
            for node_id in &doomed {
                self.store.execute(
                    "UPDATE node SET deleted = 1, deleted_at = ? WHERE account_id = ? AND id = ?",
                    &[now.into(), self.account(), node_id.as_str().into()],
                )?;
                self.emit(
                    &at,
                    node_id,
                    EventType::Updated,
                    None,
                    None,
                    Some(r#"{"deleted":true}"#),
                )?;
            }
            Ok(())
        })?;
        Ok(doomed.len())
    }

    /// Expand/collapse state. Pure view state, so it is stored but emits no event
    /// — the report would be noise if every disclosure triangle showed up in it.
    pub fn set_collapsed(&self, id: &str, collapsed: bool) -> Result<()> {
        self.store.execute(
            "UPDATE node SET collapsed = ? WHERE account_id = ? AND id = ?",
            &[collapsed.into(), self.account(), id.into()],
        )?;
        Ok(())
    }

    // -- tags --------------------------------------------------------------

    fn tags_for(&self, node_id: &str) -> Result<Vec<TagView>> {
        let rows = self.store.query(
            "SELECT t.id, t.name, t.color FROM node_tag nt \
             JOIN tag t ON t.account_id = nt.account_id AND t.id = nt.tag_id \
             WHERE nt.account_id = ? AND nt.node_id = ? AND nt.deleted = 0 AND t.deleted = 0 \
             ORDER BY t.name",
            &[self.account(), node_id.into()],
        )?;
        Ok(rows.iter().map(|r| decode_tag(r)).collect())
    }

    fn all_tags_by_node(&self) -> Result<HashMap<String, Vec<TagView>>> {
        let rows = self.store.query(
            "SELECT nt.node_id, t.id, t.name, t.color FROM node_tag nt \
             JOIN tag t ON t.account_id = nt.account_id AND t.id = nt.tag_id \
             WHERE nt.account_id = ? AND nt.deleted = 0 AND t.deleted = 0 ORDER BY t.name",
            &[self.account()],
        )?;
        let mut out: HashMap<String, Vec<TagView>> = HashMap::new();
        for row in rows {
            out.entry(row[0].text_or_default())
                .or_default()
                .push(decode_tag(&row[1..]));
        }
        Ok(out)
    }

    /// Find or create a tag by name, then attach it. Tag names are the vocabulary;
    /// typing `#urgent` twice must not produce two tags.
    pub fn add_tag(&self, node_id: &str, name: &str) -> Result<TagView> {
        let at = self.stamp();
        let name = name.trim().trim_start_matches('#');
        if name.is_empty() {
            return Err(CoreError::Store("tag name cannot be empty".into()));
        }

        let existing = self.store.query_one(
            "SELECT id, name, color FROM tag WHERE account_id = ? AND name = ?",
            &[self.account(), name.into()],
        )?;

        let tag = match existing {
            Some(row) => {
                // Revive rather than duplicate: the unique index on (account, name)
                // means a tombstoned tag would otherwise block re-creating it.
                self.store.execute(
                    "UPDATE tag SET deleted = 0 WHERE account_id = ? AND id = ?",
                    &[self.account(), row[0].clone()],
                )?;
                decode_tag(&row)
            }
            None => {
                let count = self
                    .store
                    .query_i64(
                        "SELECT COUNT(*) FROM tag WHERE account_id = ?",
                        &[self.account()],
                    )?
                    .unwrap_or(0);
                let tag = TagView {
                    id: new_id().to_string(),
                    name: name.to_owned(),
                    color: HUES[count as usize % HUES.len()].to_owned(),
                };
                self.store.execute(
                    "INSERT INTO tag (account_id, id, name, color) VALUES (?, ?, ?, ?)",
                    &[
                        self.account(),
                        tag.id.as_str().into(),
                        tag.name.as_str().into(),
                        tag.color.as_str().into(),
                    ],
                )?;
                tag
            }
        };

        let now = at.wall_ms as i64;
        let hlc = at.to_string();
        self.store.transaction(|| {
            self.store.execute(
                "INSERT INTO node_tag (account_id, node_id, tag_id, added_at, deleted, hlc) \
                 VALUES (?, ?, ?, ?, 0, ?) \
                 ON CONFLICT (account_id, node_id, tag_id) \
                 DO UPDATE SET deleted = 0, added_at = excluded.added_at, hlc = excluded.hlc",
                &[
                    self.account(),
                    node_id.into(),
                    tag.id.as_str().into(),
                    now.into(),
                    hlc.as_str().into(),
                ],
            )?;
            self.emit(&at, node_id, EventType::Tagged, None, Some(&tag.name), None)
        })?;

        Ok(tag)
    }

    /// Un-tag: tombstone the join, never delete the row, so the removal merges.
    pub fn remove_tag(&self, node_id: &str, tag_id: &str) -> Result<()> {
        let at = self.stamp();
        let hlc = self.clock.borrow_mut().now().to_string();
        self.store.transaction(|| {
            self.store.execute(
                "UPDATE node_tag SET deleted = 1, hlc = ? \
                 WHERE account_id = ? AND node_id = ? AND tag_id = ?",
                &[
                    hlc.as_str().into(),
                    self.account(),
                    node_id.into(),
                    tag_id.into(),
                ],
            )?;
            self.emit(&at, node_id, EventType::Untagged, Some(tag_id), None, None)
        })
    }

    /// Recolor a tag. The auto-assigned hue is a default, not a sentence.
    pub fn set_tag_color(&self, tag_id: &str, color: &str) -> Result<()> {
        self.store.execute(
            "UPDATE tag SET color = ? WHERE account_id = ? AND id = ?",
            &[color.into(), self.account(), tag_id.into()],
        )?;
        Ok(())
    }

    pub fn list_tags(&self) -> Result<Vec<TagView>> {
        let rows = self.store.query(
            "SELECT id, name, color FROM tag WHERE account_id = ? AND deleted = 0 ORDER BY name",
            &[self.account()],
        )?;
        Ok(rows.iter().map(|r| decode_tag(r)).collect())
    }

    // -- collections -------------------------------------------------------

    fn collections_for(&self, node_id: &str) -> Result<Vec<String>> {
        let rows = self.store.query(
            "SELECT collection_id FROM node_collection \
             WHERE account_id = ? AND node_id = ? AND tombstone = 0",
            &[self.account(), node_id.into()],
        )?;
        Ok(rows.iter().map(|r| r[0].text_or_default()).collect())
    }

    fn all_collections_by_node(&self) -> Result<HashMap<String, Vec<String>>> {
        let rows = self.store.query(
            "SELECT node_id, collection_id FROM node_collection \
             WHERE account_id = ? AND tombstone = 0",
            &[self.account()],
        )?;
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            out.entry(row[0].text_or_default())
                .or_default()
                .push(row[1].text_or_default());
        }
        Ok(out)
    }

    pub fn create_collection(&self, name: &str, parent_id: Option<&str>) -> Result<CollectionView> {
        let name = name.trim();
        if name.is_empty() {
            return Err(CoreError::Store("collection name cannot be empty".into()));
        }
        let id = new_id().to_string();
        let now = self.now_ms();
        // Same round-robin as tags: the sidebar needs a dot colour per collection,
        // and picking it here means the colour is stored once rather than
        // re-derived (and possibly differently) by each host's UI.
        let count = self
            .store
            .query_i64(
                "SELECT COUNT(*) FROM collection WHERE account_id = ?",
                &[self.account()],
            )?
            .unwrap_or(0);
        let color = HUES[count as usize % HUES.len()].to_owned();
        self.store.execute(
            "INSERT INTO collection (account_id, id, name, parent_id, owner_id, color, \
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                self.account(),
                id.as_str().into(),
                name.into(),
                parent_id.map(str::to_owned).into(),
                self.account(),
                color.as_str().into(),
                now.into(),
                now.into(),
            ],
        )?;
        Ok(CollectionView {
            id,
            name: name.to_owned(),
            parent_id: parent_id.map(str::to_owned),
            color,
            icon: String::new(),
            node_count: 0,
        })
    }

    pub fn list_collections(&self) -> Result<Vec<CollectionView>> {
        let rows = self.store.query(
            "SELECT c.id, c.name, c.parent_id, c.color, c.icon, \
             (SELECT COUNT(*) FROM node_collection nc JOIN node n \
                ON n.account_id = nc.account_id AND n.id = nc.node_id \
              WHERE nc.account_id = c.account_id AND nc.collection_id = c.id \
                AND nc.tombstone = 0 AND n.deleted = 0) \
             FROM collection c WHERE c.account_id = ? AND c.tombstone = 0 ORDER BY c.name",
            &[self.account()],
        )?;
        Ok(rows
            .iter()
            .map(|r| CollectionView {
                id: r[0].text_or_default(),
                name: r[1].text_or_default(),
                parent_id: r[2].as_str().map(str::to_owned),
                color: r[3].text_or_default(),
                icon: r[4].text_or_default(),
                node_count: r[5].as_i64().unwrap_or(0),
            })
            .collect())
    }

    /// Membership is many-to-many: adding to a second Collection does not remove
    /// the first. There is no single-select bucket anywhere in this model.
    pub fn add_to_collection(&self, node_id: &str, collection_id: &str) -> Result<()> {
        let at = self.stamp();
        let hlc = self.clock.borrow_mut().now().to_string();
        self.store.transaction(|| {
            self.store.execute(
                "INSERT INTO node_collection (account_id, node_id, collection_id, tombstone, hlc) \
                 VALUES (?, ?, ?, 0, ?) \
                 ON CONFLICT (account_id, node_id, collection_id) \
                 DO UPDATE SET tombstone = 0, hlc = excluded.hlc",
                &[
                    self.account(),
                    node_id.into(),
                    collection_id.into(),
                    hlc.as_str().into(),
                ],
            )?;
            self.emit(
                &at,
                node_id,
                EventType::CollectionAdded,
                None,
                Some(collection_id),
                None,
            )
        })
    }

    pub fn remove_from_collection(&self, node_id: &str, collection_id: &str) -> Result<()> {
        let at = self.stamp();
        let hlc = self.clock.borrow_mut().now().to_string();
        self.store.transaction(|| {
            self.store.execute(
                "UPDATE node_collection SET tombstone = 1, hlc = ? \
                 WHERE account_id = ? AND node_id = ? AND collection_id = ?",
                &[
                    hlc.as_str().into(),
                    self.account(),
                    node_id.into(),
                    collection_id.into(),
                ],
            )?;
            self.emit(
                &at,
                node_id,
                EventType::CollectionRemoved,
                Some(collection_id),
                None,
                None,
            )
        })
    }

    // -- events ------------------------------------------------------------

    /// Events in `[from_ms, to_ms)`, oldest first — the EOD report's input.
    pub fn events_between(&self, from_ms: i64, to_ms: i64) -> Result<Vec<EventView>> {
        let rows = self.store.query(
            "SELECT id, node_id, type, from_value, to_value, occurred_at, occurred_ms \
             FROM event WHERE account_id = ? AND occurred_ms >= ? AND occurred_ms < ? \
             ORDER BY occurred_ms, occurred_at",
            &[self.account(), from_ms.into(), to_ms.into()],
        )?;
        Ok(rows
            .iter()
            .map(|r| EventView {
                id: r[0].text_or_default(),
                node_id: r[1].text_or_default(),
                r#type: r[2].text_or_default(),
                from_value: r[3].as_str().map(str::to_owned),
                to_value: r[4].as_str().map(str::to_owned),
                occurred_at: r[5].text_or_default(),
                occurred_ms: r[6].as_i64().unwrap_or(0),
            })
            .collect())
    }

    // -- attachments -------------------------------------------------------

    /// Store bytes and return their SHA-256, lowercase hex.
    ///
    /// Content-addressed, so this is idempotent: pasting the same screenshot into
    /// three todos stores one copy and yields one name. That is also what lets
    /// Phase 2's blob channel ask for bytes without any coordination — the hash
    /// is the request.
    pub fn put_blob(&self, mime: &str, bytes: &[u8]) -> Result<String> {
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", Sha256::digest(bytes));

        // `OR IGNORE`, not `OR REPLACE`: identical content by definition, so a
        // rewrite would burn a page write to store what is already there.
        self.store.execute(
            "INSERT OR IGNORE INTO blob (account_id, hash, mime, bytes, byte_size, created_at)              VALUES (?, ?, ?, ?, ?, ?)",
            &[
                self.account(),
                hash.as_str().into(),
                mime.into(),
                bytes.to_vec().into(),
                (bytes.len() as i64).into(),
                self.now_ms().into(),
            ],
        )?;
        Ok(hash)
    }

    /// Read an attachment back. `None` when the bytes are not here — which in
    /// Phase 2 will also mean "not downloaded yet", not just "does not exist".
    pub fn blob(&self, hash: &str) -> Result<Option<BlobView>> {
        let rows = self.store.query(
            "SELECT hash, mime, bytes, byte_size FROM blob WHERE account_id = ? AND hash = ?",
            &[self.account(), hash.into()],
        )?;
        Ok(rows.first().map(|r| BlobView {
            hash: r[0].text_or_default(),
            mime: r[1].text_or_default(),
            bytes: r[2].as_blob().unwrap_or_default().to_vec(),
            byte_size: r[3].as_i64().unwrap_or(0),
        }))
    }

    /// Every attachment's metadata, newest first — without the bytes.
    ///
    /// Deliberately separate from [`Engine::blob`]: a listing that carried the
    /// bytes would pull every image in the account through the wasm boundary to
    /// render a size column.
    pub fn list_blobs(&self) -> Result<Vec<BlobMeta>> {
        let rows = self.store.query(
            "SELECT hash, mime, byte_size, created_at FROM blob WHERE account_id = ?              ORDER BY created_at DESC",
            &[self.account()],
        )?;
        Ok(rows
            .iter()
            .map(|r| BlobMeta {
                hash: r[0].text_or_default(),
                mime: r[1].text_or_default(),
                byte_size: r[2].as_i64().unwrap_or(0),
                created_at: r[3].as_i64().unwrap_or(0),
            })
            .collect())
    }

    /// The timestamp of each node's most recent *user* event.
    ///
    /// The report needs "when was this last actually worked on", and the answer
    /// has to come from the log rather than from `node.updated_at`: the row and
    /// its event are stamped from two clock reads, so they can differ by a
    /// millisecond, and mixing the two made "touched before this range" flicker
    /// for anything created right on a range boundary. `carried_over` is excluded
    /// because it is the report's own bookkeeping, not work.
    pub fn last_event_ms(&self) -> Result<Vec<(String, i64)>> {
        let rows = self.store.query(
            "SELECT node_id, MAX(occurred_ms) FROM event WHERE account_id = ? \
             AND type != 'carried_over' GROUP BY node_id",
            &[self.account()],
        )?;
        Ok(rows
            .iter()
            .map(|r| (r[0].text_or_default(), r[1].as_i64().unwrap_or(0)))
            .collect())
    }

    /// How many times each node has been carried into a later report.
    ///
    /// One grouped query rather than a per-node lookup: the report needs this for
    /// every carried item at once, and the EOD view is the one screen where a
    /// query-per-row would be felt.
    pub fn carry_over_counts(&self) -> Result<Vec<(String, i64)>> {
        let rows = self.store.query(
            "SELECT node_id, COUNT(*) FROM event WHERE account_id = ? \
             AND type = 'carried_over' GROUP BY node_id",
            &[self.account()],
        )?;
        Ok(rows
            .iter()
            .map(|r| (r[0].text_or_default(), r[1].as_i64().unwrap_or(0)))
            .collect())
    }

    /// Append a `carried_over` event stamped with the local day it belongs to.
    ///
    /// The day key lives in `payload` so [`Engine::commit_carry_over`] can ask
    /// "did today already roll this one forward?" without re-deriving local
    /// midnight from a UTC timestamp inside SQL.
    pub(crate) fn emit_carry_over(&self, node_id: &str, day_key: &str) -> Result<()> {
        let at = self.stamp();
        self.store.transaction(|| {
            self.emit(
                &at,
                node_id,
                EventType::CarriedOver,
                None,
                None,
                Some(day_key),
            )
        })
    }

    /// The account id as a bindable value — used by [`crate::report`], which
    /// lives in a sibling module and cannot reach the private field.
    pub(crate) fn account_value(&self) -> SqlValue {
        self.account()
    }

    /// The engine's current wall clock, for tests that need a range around now.
    #[cfg(test)]
    pub(crate) fn now_for_test(&self) -> i64 {
        self.now_ms()
    }

    /// Every event for one node, oldest first.
    pub fn events_for_node(&self, node_id: &str) -> Result<Vec<EventView>> {
        let rows = self.store.query(
            "SELECT id, node_id, type, from_value, to_value, occurred_at, occurred_ms \
             FROM event WHERE account_id = ? AND node_id = ? ORDER BY occurred_ms, occurred_at",
            &[self.account(), node_id.into()],
        )?;
        Ok(rows
            .iter()
            .map(|r| EventView {
                id: r[0].text_or_default(),
                node_id: r[1].text_or_default(),
                r#type: r[2].text_or_default(),
                from_value: r[3].as_str().map(str::to_owned),
                to_value: r[4].as_str().map(str::to_owned),
                occurred_at: r[5].text_or_default(),
                occurred_ms: r[6].as_i64().unwrap_or(0),
            })
            .collect())
    }
}

// -- helpers ---------------------------------------------------------------

fn decode_node(
    row: &[SqlValue],
    depth: usize,
    categories: &HashMap<String, StatusCategory>,
) -> NodeView {
    let status = row[6].text_or_default();
    NodeView {
        id: row[0].text_or_default(),
        parent_id: row[1].as_str().map(str::to_owned),
        kind: Kind::parse(&row[2].text_or_default()),
        promoted: row[3].as_bool(),
        title: row[4].text_or_default(),
        body_md: row[5].text_or_default(),
        // An unknown id resolves Open — never hide work over vocabulary.
        status_category: categories
            .get(&status)
            .copied()
            .unwrap_or(StatusCategory::Open),
        status,
        order_key: row[7].text_or_default(),
        created_at: row[8].as_i64().unwrap_or(0),
        updated_at: row[9].as_i64().unwrap_or(0),
        due_at: row[10].as_i64(),
        completed_at: row[11].as_i64(),
        collapsed: row[12].as_bool(),
        depth,
        has_children: false,
        tags: Vec::new(),
        collection_ids: Vec::new(),
    }
}

/// The title Daybook derives from a body — its first meaningful line, with the
/// markdown that decorates it stripped off.
///
/// A row showing `# August 22, 2026` is the syntax leaking into the UI; the title
/// is the *text*, and the `#` belongs only to the body. The same reasoning applies
/// to the report, which renders titles inside its own bullet markup.
///
/// Only leading block markers are stripped. Inline emphasis is left alone: `**` in
/// the middle of a title is content, and removing it would need a full markdown
/// parse to do correctly.
pub fn derive_title(body: &str) -> String {
    let Some(line) = body.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return String::new();
    };

    let mut text = line;
    // Markers nest — `> - [ ] thing` is a quoted, unchecked list item — so peel
    // repeatedly until nothing more comes off.
    loop {
        let before = text;

        if let Some(rest) = text.strip_prefix('>') {
            text = rest.trim_start();
        }
        // ATX heading: `#` through `######`.
        if text.starts_with('#') {
            let hashes = text.chars().take_while(|c| *c == '#').count();
            if hashes <= 6 {
                let rest = &text[hashes..];
                // `#tag` is a tag, not a heading — a heading needs whitespace.
                if rest.starts_with(char::is_whitespace) || rest.is_empty() {
                    text = rest.trim_start();
                }
            }
        }
        // Bullet list: `-`, `*`, `+`, each requiring a following space so that
        // `*emphasis*` and `-5 degrees` are not mistaken for markers.
        for marker in ['-', '*', '+'] {
            if let Some(rest) = text.strip_prefix(marker) {
                if rest.starts_with(char::is_whitespace) {
                    text = rest.trim_start();
                    break;
                }
            }
        }
        // Ordered list: `1.` / `1)`.
        let digits = text.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 {
            let rest = &text[digits..];
            if let Some(rest) = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')')) {
                if rest.starts_with(char::is_whitespace) {
                    text = rest.trim_start();
                }
            }
        }
        // Task checkbox, which only ever follows a list marker.
        for box_marker in ["[ ]", "[x]", "[X]"] {
            if let Some(rest) = text.strip_prefix(box_marker) {
                text = rest.trim_start();
                break;
            }
        }

        if text == before {
            break;
        }
    }

    // Trailing `#`s close an ATX heading and are decoration, not content.
    text.trim_end().trim_end_matches('#').trim_end().to_owned()
}

fn decode_tag(row: &[SqlValue]) -> TagView {
    TagView {
        id: row[0].text_or_default(),
        name: row[1].text_or_default(),
        color: row[2].text_or_default(),
    }
}

/// Depth-first flatten into document order, carrying `depth` down.
///
/// `seen` guards against a cycle in stored data: a parent chain that loops would
/// otherwise recurse until the stack gives out, taking the whole UI with it.
fn flatten(
    by_parent: &HashMap<Option<String>, Vec<NodeView>>,
    parent: Option<String>,
    depth: usize,
    out: &mut Vec<NodeView>,
    tags: &mut HashMap<String, Vec<TagView>>,
    collections: &mut HashMap<String, Vec<String>>,
    seen: &mut Vec<String>,
) {
    let Some(children) = by_parent.get(&parent) else {
        return;
    };
    for child in children {
        if seen.contains(&child.id) {
            continue;
        }
        seen.push(child.id.clone());

        let mut view = child.clone();
        view.depth = depth;
        view.has_children = by_parent
            .get(&Some(child.id.clone()))
            .is_some_and(|c| !c.is_empty());
        view.tags = tags.remove(&child.id).unwrap_or_default();
        view.collection_ids = collections.remove(&child.id).unwrap_or_default();
        out.push(view);

        flatten(
            by_parent,
            Some(child.id.clone()),
            depth + 1,
            out,
            tags,
            collections,
            seen,
        );
    }
}

fn load_body(state_b64: &str, client_id: u64) -> Result<YrsBody> {
    if state_b64.is_empty() {
        return Ok(YrsBody::new(client_id));
    }
    let bytes = b64::decode(state_b64).map_err(|e| CoreError::Codec(e.to_owned()))?;
    YrsBody::from_snapshot(client_id, &BodyUpdate(bytes))
}

/// Turn "the text is now this" into the minimal CRDT splice that gets there.
///
/// Trims the common prefix and suffix and rewrites only the middle. For ordinary
/// typing that is a one- or two-character edit rather than a whole-document
/// replacement, which is what keeps concurrent merges meaningful instead of
/// resolving to "one side clobbered the other".
fn apply_text_change(body: &mut YrsBody, new_text: &str) -> Result<()> {
    let old = body.text();
    if old == new_text {
        return Ok(());
    }

    let old_chars: Vec<char> = old.chars().collect();
    let new_chars: Vec<char> = new_text.chars().collect();

    let prefix = old_chars
        .iter()
        .zip(new_chars.iter())
        .take_while(|(a, b)| a == b)
        .count();

    // Bound the suffix so it cannot overlap the prefix on either side.
    let max_suffix = old_chars.len().min(new_chars.len()) - prefix;
    let mut suffix = 0;
    while suffix < max_suffix
        && old_chars[old_chars.len() - 1 - suffix] == new_chars[new_chars.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let utf16_len = |chars: &[char]| chars.iter().map(|c| c.len_utf16()).sum::<usize>() as u32;

    let at = utf16_len(&old_chars[..prefix]);
    let removed = utf16_len(&old_chars[prefix..old_chars.len() - suffix]);
    let inserted: String = new_chars[prefix..new_chars.len() - suffix].iter().collect();

    if removed > 0 {
        body.remove(at, removed)?;
    }
    if !inserted.is_empty() {
        body.insert(at, &inserted)?;
    }
    Ok(())
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::store::SqliteStore;

    fn engine() -> Engine<SqliteStore> {
        Engine::open(
            SqliteStore::in_memory().unwrap(),
            "acct-test",
            DeviceId::from("device-test-0001"),
        )
        .unwrap()
    }

    fn titles(e: &Engine<SqliteStore>) -> Vec<String> {
        e.list_tree()
            .unwrap()
            .into_iter()
            .map(|n| n.title)
            .collect()
    }

    fn event_types(e: &Engine<SqliteStore>, node_id: &str) -> Vec<String> {
        e.events_for_node(node_id)
            .unwrap()
            .into_iter()
            .map(|ev| ev.r#type)
            .collect()
    }

    // -- creation & ordering ------------------------------------------------

    #[test]
    fn created_nodes_appear_in_insertion_order() {
        let e = engine();
        let first = e.create_node(None, "first", None).unwrap();
        let second = e.create_node(None, "second", Some(&first.id)).unwrap();
        e.create_node(None, "third", Some(&second.id)).unwrap();
        assert_eq!(titles(&e), ["first", "second", "third"]);
    }

    #[test]
    fn inserting_between_two_nodes_lands_between_them() {
        let e = engine();
        let a = e.create_node(None, "a", None).unwrap();
        let c = e.create_node(None, "c", Some(&a.id)).unwrap();
        e.create_node(None, "b", Some(&a.id)).unwrap();
        assert_eq!(titles(&e), ["a", "b", "c"]);
        assert!(!c.order_key.is_empty());
    }

    #[test]
    fn inserting_first_puts_a_node_at_the_top() {
        let e = engine();
        let a = e.create_node(None, "a", None).unwrap();
        e.create_node(None, "b", Some(&a.id)).unwrap();
        e.create_node(None, "zero", None).unwrap();
        assert_eq!(titles(&e), ["zero", "a", "b"]);
    }

    #[test]
    fn children_nest_under_their_parent_in_document_order() {
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        let c1 = e.create_node(Some(&root.id), "child-1", None).unwrap();
        e.create_node(Some(&root.id), "child-2", Some(&c1.id))
            .unwrap();
        e.create_node(None, "sibling", Some(&root.id)).unwrap();

        assert_eq!(titles(&e), ["root", "child-1", "child-2", "sibling"]);
        let tree = e.list_tree().unwrap();
        assert_eq!(tree[0].depth, 0);
        assert_eq!(tree[1].depth, 1);
        assert_eq!(tree[2].depth, 1);
        assert_eq!(tree[3].depth, 0);
        assert!(tree[0].has_children);
        assert!(!tree[1].has_children);
    }

    // -- the event log ------------------------------------------------------

    #[test]
    fn the_same_bytes_get_the_same_name_and_are_stored_once() {
        let e = engine();
        let png = b"\x89PNG\r\n\x1a\n fake image bytes";

        let first = e.put_blob("image/png", png).unwrap();
        let second = e.put_blob("image/png", png).unwrap();
        assert_eq!(
            first, second,
            "content addressing is not content addressing"
        );
        assert_eq!(e.list_blobs().unwrap().len(), 1, "stored twice");

        // Lowercase hex SHA-256.
        assert_eq!(first.len(), 64);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn different_bytes_get_different_names() {
        let e = engine();
        let a = e.put_blob("image/png", b"one").unwrap();
        let b = e.put_blob("image/png", b"two").unwrap();
        assert_ne!(a, b);
        assert_eq!(e.list_blobs().unwrap().len(), 2);
    }

    #[test]
    fn bytes_survive_the_round_trip_unchanged() {
        let e = engine();
        // Every byte value, so a text-column round trip or a stray UTF-8
        // conversion anywhere in the store port would corrupt it.
        let bytes: Vec<u8> = (0..=255u8).cycle().take(1024).collect();
        let hash = e.put_blob("application/octet-stream", &bytes).unwrap();

        let read = e.blob(&hash).unwrap().expect("blob vanished");
        assert_eq!(read.bytes, bytes);
        assert_eq!(read.byte_size, 1024);
        assert_eq!(read.mime, "application/octet-stream");
    }

    #[test]
    fn an_unknown_hash_is_none_rather_than_an_error() {
        let e = engine();
        // In Phase 2 this also means "not downloaded yet", so it has to be an
        // ordinary absence the UI can degrade around, not a failure.
        assert!(e.blob("0".repeat(64).as_str()).unwrap().is_none());
    }

    #[test]
    fn listing_attachments_leaves_the_bytes_behind() {
        let e = engine();
        let big = vec![7u8; 4096];
        let hash = e.put_blob("image/png", &big).unwrap();

        let listed = e.list_blobs().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].hash, hash);
        assert_eq!(listed[0].byte_size, 4096);
    }

    #[test]
    fn attachments_are_scoped_to_their_account() {
        let store = SqliteStore::in_memory().unwrap();
        store.init_schema().unwrap();
        let mine = Engine::open(store, "acct-a", DeviceId::from("device-aaaa-0001")).unwrap();
        let hash = mine.put_blob("image/png", b"secret").unwrap();

        let other = Engine::open(
            SqliteStore::in_memory().unwrap(),
            "acct-b",
            DeviceId::from("device-bbbb-0001"),
        )
        .unwrap();
        assert!(other.blob(&hash).unwrap().is_none());
        assert!(other.list_blobs().unwrap().is_empty());
    }

    #[test]
    fn statuses_are_seeded_once_with_categories() {
        let e = engine();
        let statuses = e.list_statuses().unwrap();
        let ids: Vec<&str> = statuses.iter().map(|s| s.id.as_str()).collect();
        // Both Waiting and Blocked ship; which survives is the user's call.
        assert_eq!(
            ids,
            [
                "todo",
                "in_progress",
                "waiting",
                "blocked",
                "done",
                "dropped"
            ]
        );
        assert!(statuses.iter().all(|s| s.built_in));
    }

    #[test]
    fn a_custom_status_works_end_to_end() {
        let e = engine();
        let errand = e
            .create_status("On hold", StatusCategory::Open, None)
            .unwrap();
        let node = e.create_node(None, "Call the bank", None).unwrap();

        e.set_status(&node.id, &errand.id).unwrap();
        let read = e.node(&node.id).unwrap().unwrap();
        assert_eq!(read.status, errand.id);
        assert_eq!(read.status_category, StatusCategory::Open);

        // `x` still lands on the default done status, whatever else exists.
        e.toggle_done(&node.id).unwrap();
        assert_eq!(e.node(&node.id).unwrap().unwrap().status, "done");
    }

    #[test]
    fn a_custom_done_status_completes_like_done() {
        let e = engine();
        let shipped = e
            .create_status("Handed over", StatusCategory::Done, None)
            .unwrap();
        let node = e.create_node(None, "Lend the drill", None).unwrap();
        e.set_status(&node.id, &shipped.id).unwrap();

        let read = e.node(&node.id).unwrap().unwrap();
        assert_eq!(read.status_category, StatusCategory::Done);
        assert!(
            read.completed_at.is_some(),
            "a done-category status must complete"
        );

        let events = e.events_for_node(&node.id).unwrap();
        assert!(
            events.iter().any(|ev| ev.r#type == "completed"),
            "category, not id, decides what finishing means"
        );
    }

    #[test]
    fn deleting_a_status_reassigns_its_nodes() {
        let e = engine();
        let node = e.create_node(None, "Waiting on plumber", None).unwrap();
        e.set_status(&node.id, "waiting").unwrap();

        e.delete_status("waiting").unwrap();
        assert_eq!(
            e.node(&node.id).unwrap().unwrap().status,
            "todo",
            "orphaned nodes must land on the category default"
        );
        assert!(
            !e.list_statuses().unwrap().iter().any(|s| s.id == "waiting"),
            "deleted status still listed"
        );
    }

    #[test]
    fn the_last_open_and_done_statuses_cannot_be_deleted() {
        let e = engine();
        for id in ["in_progress", "waiting", "blocked"] {
            e.delete_status(id).unwrap();
        }
        assert!(
            e.delete_status("todo").is_err(),
            "deleted the last open status"
        );
        assert!(
            e.delete_status("done").is_err(),
            "deleted the last done status"
        );
        // Dropped is cancelled-category and deletable.
        e.delete_status("dropped").unwrap();
    }

    #[test]
    fn deleted_builtins_stay_deleted_across_reopen() {
        let store = SqliteStore::in_memory().unwrap();
        store.init_schema().unwrap();
        let e = Engine::open(store, "acct-test", DeviceId::from("device-test-0001")).unwrap();
        e.delete_status("blocked").unwrap();

        // Same underlying store, fresh engine — a relaunch.
        let store2 = e.into_store();
        let e2 = Engine::open(store2, "acct-test", DeviceId::from("device-test-0001")).unwrap();
        assert!(
            !e2.list_statuses()
                .unwrap()
                .iter()
                .any(|s| s.id == "blocked"),
            "seeding resurrected a deleted built-in"
        );
    }

    #[test]
    fn renaming_done_does_not_change_what_finishing_means() {
        let e = engine();
        e.rename_status("done", "Shipped").unwrap();
        let node = e.create_node(None, "task", None).unwrap();
        e.toggle_done(&node.id).unwrap();
        let read = e.node(&node.id).unwrap().unwrap();
        assert_eq!(read.status_category, StatusCategory::Done);
        assert!(read.completed_at.is_some());
    }

    #[test]
    fn a_tag_can_be_recolored() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        let tag = e.add_tag(&node.id, "garden").unwrap();
        e.set_tag_color(&tag.id, "lime").unwrap();
        assert_eq!(
            e.list_tags().unwrap()[0].color,
            "lime",
            "recolor did not stick"
        );
    }

    #[test]
    fn a_due_date_can_be_set_and_cleared() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        assert_eq!(node.due_at, None);

        e.set_due(&node.id, Some(1_787_443_200_000)).unwrap();
        assert_eq!(
            e.node(&node.id).unwrap().unwrap().due_at,
            Some(1_787_443_200_000)
        );

        e.set_due(&node.id, None).unwrap();
        assert_eq!(e.node(&node.id).unwrap().unwrap().due_at, None);
    }

    #[test]
    fn setting_the_same_due_date_writes_nothing() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        e.set_due(&node.id, Some(1_000)).unwrap();
        let before = e.events_for_node(&node.id).unwrap().len();

        e.set_due(&node.id, Some(1_000)).unwrap();
        assert_eq!(
            e.events_for_node(&node.id).unwrap().len(),
            before,
            "a no-op re-save filled the report with `updated` noise"
        );
    }

    #[test]
    fn a_due_date_pulls_a_stale_todo_back_into_the_report() {
        use crate::report::ReportOptions;
        let e = engine();
        let node = e.create_node(None, "Overdue thing", None).unwrap();
        let touched = e.last_event_ms().unwrap()[0].1;

        // Far outside the carry-over window: without a due date this is
        // inventory, not today's news.
        let mut options = ReportOptions {
            from_ms: touched + 30 * 86_400_000,
            to_ms: touched + 31 * 86_400_000,
            date_label: "d".into(),
            carry_over_window_days: 7,
            ..Default::default()
        };
        assert_eq!(e.generate_report(&options).unwrap().counts.carried_over, 0);

        e.set_due(&node.id, Some(options.from_ms + 1)).unwrap();
        // `set_due` is itself an event, so the range has to start after it for
        // this to test the due date rather than the touch.
        options.from_ms = e.last_event_ms().unwrap()[0].1 + 1;
        assert_eq!(
            e.generate_report(&options).unwrap().counts.carried_over,
            1,
            "a due date in play did not keep the item in scope"
        );
    }

    #[test]
    fn a_change_and_its_event_carry_the_same_timestamp() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();

        let created = e
            .events_for_node(&node.id)
            .unwrap()
            .into_iter()
            .find(|ev| ev.r#type == "created")
            .expect("no created event");
        assert_eq!(
            node.created_at, created.occurred_ms,
            "the row and the event that made it were stamped from two clock reads"
        );

        e.set_title(&node.id, "renamed").unwrap();
        let after = e.node(&node.id).unwrap().unwrap();
        let last = e
            .events_for_node(&node.id)
            .unwrap()
            .pop()
            .expect("no events");
        assert_eq!(
            after.updated_at, last.occurred_ms,
            "updated_at drifted from the event that caused it"
        );

        e.toggle_done(&node.id).unwrap();
        let done = e.node(&node.id).unwrap().unwrap();
        let completion = e
            .events_for_node(&node.id)
            .unwrap()
            .into_iter()
            .find(|ev| ev.r#type == "completed")
            .expect("no completed event");
        assert_eq!(done.completed_at, Some(completion.occurred_ms));
    }

    #[test]
    fn every_state_change_writes_an_event() {
        // Phase 1 exit criterion: "The EVENT log records create/update/complete/
        // promote for every node."
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        e.set_title(&node.id, "renamed").unwrap();
        e.toggle_done(&node.id).unwrap();
        e.promote(&node.id).unwrap();

        let types = event_types(&e, &node.id);
        assert!(types.contains(&"created".to_string()));
        assert!(types.contains(&"updated".to_string()));
        assert!(types.contains(&"completed".to_string()));
        assert!(types.contains(&"promoted".to_string()));
    }

    #[test]
    fn events_are_ordered_and_queryable_by_range() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        e.set_title(&node.id, "renamed").unwrap();

        let all = e.events_between(0, i64::MAX).unwrap();
        assert!(all.len() >= 2);
        assert!(
            all.windows(2).all(|w| w[0].occurred_ms <= w[1].occurred_ms),
            "events came back out of order"
        );
        assert!(
            e.events_between(0, 1).unwrap().is_empty(),
            "a range before any activity should be empty"
        );
    }

    #[test]
    fn reopening_a_done_node_is_distinct_from_completing_it() {
        // The report treats these differently; collapsing both into
        // `status_changed` would lose the distinction.
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        e.toggle_done(&node.id).unwrap();
        e.toggle_done(&node.id).unwrap();

        let types = event_types(&e, &node.id);
        assert!(types.contains(&"completed".to_string()));
        assert!(types.contains(&"reopened".to_string()));
    }

    #[test]
    fn a_no_op_change_writes_no_event() {
        // Otherwise the report fills with "updated" noise from re-saving unchanged
        // text, which is exactly what an autosaving editor does constantly.
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        let before = e.events_for_node(&node.id).unwrap().len();

        e.set_title(&node.id, "task").unwrap();
        e.set_body(&node.id, "").unwrap();
        e.set_status(&node.id, "todo").unwrap();

        assert_eq!(e.events_for_node(&node.id).unwrap().len(), before);
    }

    #[test]
    fn completing_a_node_stamps_completed_at_and_reopening_clears_it() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        e.toggle_done(&node.id).unwrap();
        let done = e.node(&node.id).unwrap().unwrap();
        assert_eq!(done.status, "done");
        assert_eq!(done.status_category, StatusCategory::Done);
        assert!(done.completed_at.is_some());

        e.toggle_done(&node.id).unwrap();
        let reopened = e.node(&node.id).unwrap().unwrap();
        assert_eq!(reopened.status, "todo");
        assert!(reopened.completed_at.is_none());
    }

    // -- promotion ----------------------------------------------------------

    #[test]
    fn promotion_keeps_the_row_its_id_and_its_place() {
        // Phase 1 exit criterion: "A sub-item can be promoted to a full todo
        // without a row copy or losing position."
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        let a = e.create_node(Some(&root.id), "a", None).unwrap();
        let child = e
            .create_node(Some(&root.id), "promote-me", Some(&a.id))
            .unwrap();
        let before = e.node(&child.id).unwrap().unwrap();

        let row_count = |e: &Engine<SqliteStore>| {
            e.store()
                .query_i64("SELECT COUNT(*) FROM node", &[])
                .unwrap()
                .unwrap()
        };
        let rows_before = row_count(&e);

        e.promote(&child.id).unwrap();
        let after = e.node(&child.id).unwrap().unwrap();

        assert_eq!(rows_before, row_count(&e), "promotion copied a row");
        assert_eq!(after.id, before.id, "id changed");
        assert_eq!(after.parent_id, before.parent_id, "parent_id changed");
        assert_eq!(after.order_key, before.order_key, "position changed");
        assert!(after.promoted);
        assert_eq!(after.kind, Kind::Task);
        assert_eq!(titles(&e), ["root", "a", "promote-me"]);
    }

    #[test]
    fn promoting_twice_is_idempotent() {
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        let child = e.create_node(Some(&root.id), "child", None).unwrap();
        e.promote(&child.id).unwrap();
        e.promote(&child.id).unwrap();
        let promotions = event_types(&e, &child.id)
            .iter()
            .filter(|t| *t == "promoted")
            .count();
        assert_eq!(promotions, 1);
    }

    #[test]
    fn duplicate_copies_content_tags_and_collections() {
        let e = engine();
        let source = e.create_node(None, "", None).unwrap();
        e.set_body(&source.id, "# Original\nwith a body").unwrap();
        e.add_tag(&source.id, "urgent").unwrap();
        let work = e.create_collection("Work", None).unwrap();
        e.add_to_collection(&source.id, &work.id).unwrap();

        let copy = e
            .duplicate_node(&source.id, None, Some(&source.id))
            .unwrap();

        assert_ne!(copy.id, source.id, "duplicate reused the id");
        assert_eq!(copy.title, "Original");
        assert_eq!(copy.body_md, "# Original\nwith a body");
        assert_eq!(copy.tags.len(), 1);
        assert_eq!(copy.collection_ids, [work.id]);
        assert_eq!(titles(&e), ["Original", "Original"]);
    }

    #[test]
    fn duplicate_copies_the_whole_subtree() {
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        let a = e.create_node(Some(&root.id), "a", None).unwrap();
        e.create_node(Some(&root.id), "b", Some(&a.id)).unwrap();
        e.create_node(Some(&a.id), "a1", None).unwrap();

        e.duplicate_node(&root.id, None, Some(&root.id)).unwrap();

        // The copy sits after the original and keeps the subtree's shape.
        assert_eq!(titles(&e), ["root", "a", "a1", "b", "root", "a", "a1", "b"]);
        let tree = e.list_tree().unwrap();
        assert_eq!(tree[5].depth, 1, "copied child lost its depth");
        assert_eq!(tree[6].depth, 2, "copied grandchild lost its depth");
    }

    #[test]
    fn editing_a_duplicate_leaves_the_original_alone() {
        // The property that actually matters. (The two bodies may hold identical
        // CRDT *bytes* — that is fine, because each node's body is its own
        // document and Yjs only needs client ids unique within one.)
        let e = engine();
        let source = e.create_node(None, "", None).unwrap();
        e.set_body(&source.id, "shared text").unwrap();
        let copy = e
            .duplicate_node(&source.id, None, Some(&source.id))
            .unwrap();
        assert_eq!(copy.body_md, "shared text");

        e.set_body(&copy.id, "diverged").unwrap();

        assert_eq!(e.node(&copy.id).unwrap().unwrap().body_md, "diverged");
        assert_eq!(
            e.node(&source.id).unwrap().unwrap().body_md,
            "shared text",
            "editing the copy changed the original"
        );
    }

    #[test]
    fn a_duplicate_of_a_done_node_starts_open() {
        let e = engine();
        let source = e.create_node(None, "done thing", None).unwrap();
        e.toggle_done(&source.id).unwrap();

        let copy = e
            .duplicate_node(&source.id, None, Some(&source.id))
            .unwrap();
        assert_eq!(copy.status, "todo");
        assert!(copy.completed_at.is_none());
    }

    #[test]
    fn demote_reverses_a_promotion_in_place() {
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        let child = e.create_node(Some(&root.id), "child", None).unwrap();
        let before = e.node(&child.id).unwrap().unwrap();

        e.promote(&child.id).unwrap();
        e.demote(&child.id).unwrap();
        let after = e.node(&child.id).unwrap().unwrap();

        assert!(!after.promoted);
        assert_eq!(after.kind, Kind::ChecklistItem);
        assert_eq!(after.parent_id, before.parent_id, "parent changed");
        assert_eq!(after.order_key, before.order_key, "position changed");
    }

    #[test]
    fn demoting_a_root_leaves_it_a_task() {
        // A root node has no parent to be a checklist item of.
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        e.promote(&root.id).unwrap();
        e.demote(&root.id).unwrap();
        assert_eq!(e.node(&root.id).unwrap().unwrap().kind, Kind::Task);
    }

    #[test]
    fn restore_brings_back_a_deleted_subtree() {
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        let child = e.create_node(Some(&root.id), "child", None).unwrap();
        e.create_node(Some(&child.id), "grandchild", None).unwrap();

        assert_eq!(e.delete_node(&root.id).unwrap(), 3);
        assert!(e.list_tree().unwrap().is_empty());

        assert_eq!(e.restore_node(&root.id).unwrap(), 3);
        assert_eq!(titles(&e), ["root", "child", "grandchild"]);
    }

    #[test]
    fn restore_does_not_disturb_a_separately_deleted_node() {
        let e = engine();
        let keep = e.create_node(None, "deleted separately", None).unwrap();
        let undo = e.create_node(None, "deleted then undone", None).unwrap();

        e.delete_node(&keep.id).unwrap();
        e.delete_node(&undo.id).unwrap();
        e.restore_node(&undo.id).unwrap();

        assert_eq!(titles(&e), ["deleted then undone"]);
    }

    // -- structure ----------------------------------------------------------

    #[test]
    fn indent_makes_a_node_a_child_of_the_row_above() {
        let e = engine();
        let a = e.create_node(None, "a", None).unwrap();
        let b = e.create_node(None, "b", Some(&a.id)).unwrap();

        e.indent(&b.id).unwrap();

        let tree = e.list_tree().unwrap();
        assert_eq!(tree[1].parent_id.as_deref(), Some(a.id.as_str()));
        assert_eq!(tree[1].depth, 1);
    }

    #[test]
    fn indent_at_the_top_of_a_level_does_nothing() {
        let e = engine();
        let a = e.create_node(None, "a", None).unwrap();
        e.create_node(None, "b", Some(&a.id)).unwrap();
        e.indent(&a.id).unwrap();
        assert!(e.node(&a.id).unwrap().unwrap().parent_id.is_none());
    }

    #[test]
    fn outdent_moves_a_node_just_after_its_old_parent() {
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        let child = e.create_node(Some(&root.id), "child", None).unwrap();
        e.create_node(None, "next", Some(&root.id)).unwrap();

        e.outdent(&child.id).unwrap();

        assert_eq!(titles(&e), ["root", "child", "next"]);
        assert!(e.node(&child.id).unwrap().unwrap().parent_id.is_none());
    }

    #[test]
    fn outdent_at_root_does_nothing() {
        let e = engine();
        let a = e.create_node(None, "a", None).unwrap();
        e.outdent(&a.id).unwrap();
        assert!(e.node(&a.id).unwrap().unwrap().parent_id.is_none());
    }

    #[test]
    fn a_node_cannot_be_moved_beneath_itself() {
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        let child = e.create_node(Some(&root.id), "child", None).unwrap();

        assert!(e.move_node(&root.id, Some(&child.id), None).is_err());
        assert!(e.move_node(&root.id, Some(&root.id), None).is_err());
        // And the tree is untouched by the refusal.
        assert_eq!(titles(&e), ["root", "child"]);
    }

    #[test]
    fn nesting_stops_at_the_depth_cap() {
        let e = engine();
        let mut parent = e.create_node(None, "root", None).unwrap().id;
        // MAX_DEPTH levels total, so creating that many children must fail before
        // the tree exceeds the cap.
        let mut created = 1;
        for i in 0..MAX_DEPTH + 2 {
            match e.create_node(Some(&parent), &format!("level-{i}"), None) {
                Ok(node) => {
                    parent = node.id;
                    created += 1;
                }
                Err(_) => break,
            }
        }
        assert!(
            created <= MAX_DEPTH,
            "created {created} levels, cap is {MAX_DEPTH}"
        );
        assert!(created > 1, "the cap rejected everything");
    }

    // -- deletion -----------------------------------------------------------

    #[test]
    fn deleting_a_node_takes_its_subtree_and_leaves_tombstones() {
        let e = engine();
        let root = e.create_node(None, "root", None).unwrap();
        let child = e.create_node(Some(&root.id), "child", None).unwrap();
        e.create_node(Some(&child.id), "grandchild", None).unwrap();
        e.create_node(None, "survivor", Some(&root.id)).unwrap();

        let deleted = e.delete_node(&root.id).unwrap();
        assert_eq!(deleted, 3);
        assert_eq!(titles(&e), ["survivor"]);
        assert!(e.node(&root.id).unwrap().is_none());

        // Soft delete: rows stay so the delete can propagate in Phase 2.
        assert_eq!(
            e.store()
                .query_i64("SELECT COUNT(*) FROM node WHERE deleted = 1", &[])
                .unwrap(),
            Some(3)
        );
    }

    // -- bodies -------------------------------------------------------------

    #[test]
    fn a_body_round_trips_and_keeps_crdt_state() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        e.set_body(&node.id, "## Goal\nWrite it down.").unwrap();

        assert_eq!(
            e.node(&node.id).unwrap().unwrap().body_md,
            "## Goal\nWrite it down."
        );
        // The CRDT state is persisted, not just the flattened string — without it
        // Phase 2 would have no history to merge.
        let state = e
            .store()
            .query_one(
                "SELECT body_state FROM node WHERE account_id = ? AND id = ?",
                &["acct-test".into(), node.id.as_str().into()],
            )
            .unwrap()
            .unwrap();
        assert!(!state[0].text_or_default().is_empty());
    }

    #[test]
    fn successive_body_edits_apply_as_splices() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        for text in [
            "line one",
            "line one\nline two",
            "line one\nline two\nline three",
            "line one\nEDITED\nline three",
            "",
            "fresh start",
        ] {
            e.set_body(&node.id, text).unwrap();
            assert_eq!(e.node(&node.id).unwrap().unwrap().body_md, text);
        }
    }

    #[test]
    fn body_edits_survive_non_ascii_text() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        for text in [
            "café",
            "café ☕",
            "café ☕ 日本語",
            "日本語",
            "🌍🌎🌏",
            "🌍x🌏",
        ] {
            e.set_body(&node.id, text).unwrap();
            assert_eq!(e.node(&node.id).unwrap().unwrap().body_md, text);
        }
    }

    // -- tags & collections -------------------------------------------------

    #[test]
    fn tags_and_collections_are_independent_axes() {
        // Phase 1 exit criterion: "Collections (many-to-many) and Tags are
        // independently assignable."
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        let work = e.create_collection("Work", None).unwrap();
        let home = e.create_collection("Home", None).unwrap();

        e.add_tag(&node.id, "urgent").unwrap();
        e.add_tag(&node.id, "p1").unwrap();
        e.add_to_collection(&node.id, &work.id).unwrap();
        e.add_to_collection(&node.id, &home.id).unwrap();

        let view = e.node(&node.id).unwrap().unwrap();
        assert_eq!(view.tags.len(), 2);
        assert_eq!(
            view.collection_ids.len(),
            2,
            "a node must live in many collections"
        );

        // Removing from one collection touches neither the other nor the tags.
        e.remove_from_collection(&node.id, &work.id).unwrap();
        let view = e.node(&node.id).unwrap().unwrap();
        assert_eq!(view.collection_ids, [home.id]);
        assert_eq!(view.tags.len(), 2);
    }

    #[test]
    fn the_same_tag_name_never_creates_two_tags() {
        let e = engine();
        let a = e.create_node(None, "a", None).unwrap();
        let b = e.create_node(None, "b", None).unwrap();
        let first = e.add_tag(&a.id, "urgent").unwrap();
        let second = e.add_tag(&b.id, "#urgent").unwrap(); // leading # is stripped
        assert_eq!(first.id, second.id);
        assert_eq!(e.list_tags().unwrap().len(), 1);
    }

    #[test]
    fn re_tagging_after_removal_revives_the_join() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        let tag = e.add_tag(&node.id, "urgent").unwrap();
        e.remove_tag(&node.id, &tag.id).unwrap();
        assert!(e.node(&node.id).unwrap().unwrap().tags.is_empty());

        e.add_tag(&node.id, "urgent").unwrap();
        assert_eq!(e.node(&node.id).unwrap().unwrap().tags.len(), 1);
    }

    #[test]
    fn tags_get_distinct_hues_from_the_muted_set() {
        let e = engine();
        let node = e.create_node(None, "task", None).unwrap();
        let mut seen = Vec::new();
        for i in 0..HUES.len() {
            seen.push(e.add_tag(&node.id, &format!("tag{i}")).unwrap().color);
        }
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), HUES.len(), "hues were not distinct");
    }

    #[test]
    fn collections_get_a_hue_that_survives_a_reload() {
        let e = engine();
        let a = e.create_collection("Work", None).unwrap();
        let b = e.create_collection("Home", None).unwrap();
        assert!(!a.color.is_empty(), "collection created without a colour");
        assert_ne!(a.color, b.color, "consecutive collections share a hue");

        // The sidebar reads `list_collections`, not the create result — the two
        // must agree or the dot changes colour the moment the page reloads.
        let listed = e.list_collections().unwrap();
        let stored = |id: &str| {
            listed
                .iter()
                .find(|c| c.id == id)
                .map(|c| c.color.clone())
                .unwrap()
        };
        assert_eq!(stored(&a.id), a.color);
        assert_eq!(stored(&b.id), b.color);
    }

    #[test]
    fn collection_membership_counts_only_live_nodes() {
        let e = engine();
        let collection = e.create_collection("Work", None).unwrap();
        let a = e.create_node(None, "a", None).unwrap();
        let b = e.create_node(None, "b", None).unwrap();
        e.add_to_collection(&a.id, &collection.id).unwrap();
        e.add_to_collection(&b.id, &collection.id).unwrap();
        assert_eq!(e.list_collections().unwrap()[0].node_count, 2);

        e.delete_node(&b.id).unwrap();
        assert_eq!(
            e.list_collections().unwrap()[0].node_count,
            1,
            "a deleted node still counted as a member"
        );
    }

    // -- account partitioning -----------------------------------------------

    #[test]
    fn two_accounts_over_one_database_stay_partitioned() {
        // Phase 1 exit criterion: store keys are account-scoped, so a second
        // account slots in without a migration. Proven by actually running two.
        let store_a = SqliteStore::in_memory().unwrap();
        let engine_a = Engine::open(store_a, "acct-a", DeviceId::from("dev-a")).unwrap();
        engine_a.create_node(None, "a's task", None).unwrap();

        // A second engine over the *same* connection, different account.
        let engine_b = Engine::open(
            SqliteStore::in_memory().unwrap(),
            "acct-b",
            DeviceId::from("dev-b"),
        )
        .unwrap();
        engine_b.create_node(None, "b's task", None).unwrap();

        assert_eq!(titles(&engine_a), ["a's task"]);
        assert_eq!(titles(&engine_b), ["b's task"]);
    }

    #[test]
    fn one_database_serving_two_accounts_never_leaks() {
        let path =
            std::env::temp_dir().join(format!("daybook-parts-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);

        {
            let a = Engine::open(
                SqliteStore::open(&path).unwrap(),
                "acct-a",
                DeviceId::from("dev-a"),
            )
            .unwrap();
            let b = Engine::open(
                SqliteStore::open(&path).unwrap(),
                "acct-b",
                DeviceId::from("dev-b"),
            )
            .unwrap();

            a.create_node(None, "private to a", None).unwrap();
            b.create_node(None, "private to b", None).unwrap();

            assert_eq!(titles(&a), ["private to a"]);
            assert_eq!(titles(&b), ["private to b"]);
            assert!(a.events_between(0, i64::MAX).unwrap().len() == 1);
        }
        let _ = std::fs::remove_file(&path);
    }

    // -- durability ---------------------------------------------------------

    #[test]
    fn state_survives_closing_and_reopening_the_database() {
        // Phase 1 exit criterion: "Killing and relaunching the app loses nothing."
        let path =
            std::env::temp_dir().join(format!("daybook-durable-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let node_id;
        {
            let e = Engine::open(
                SqliteStore::open(&path).unwrap(),
                "acct",
                DeviceId::from("dev"),
            )
            .unwrap();
            let node = e.create_node(None, "persistent", None).unwrap();
            e.set_body(&node.id, "body text").unwrap();
            e.add_tag(&node.id, "urgent").unwrap();
            node_id = node.id;
        } // dropped: connection closed

        {
            let e = Engine::open(
                SqliteStore::open(&path).unwrap(),
                "acct",
                DeviceId::from("dev"),
            )
            .unwrap();
            let node = e.node(&node_id).unwrap().expect("node did not survive");
            assert_eq!(node.title, "persistent");
            assert_eq!(node.body_md, "body text");
            assert_eq!(node.tags.len(), 1);
            assert!(!e.events_for_node(&node_id).unwrap().is_empty());
        }

        let _ = std::fs::remove_file(&path);
    }

    // -- derived titles -----------------------------------------------------

    #[test]
    fn title_strips_the_markdown_that_decorates_it() {
        // The bug this fixes: rows rendered `# August 22, 2026`, syntax and all.
        assert_eq!(derive_title("# August 22, 2026"), "August 22, 2026");
        assert_eq!(derive_title("### Deep heading"), "Deep heading");
        assert_eq!(derive_title("- a bullet"), "a bullet");
        assert_eq!(derive_title("* star bullet"), "star bullet");
        assert_eq!(derive_title("1. numbered"), "numbered");
        assert_eq!(derive_title("2) also numbered"), "also numbered");
        assert_eq!(derive_title("- [ ] unchecked task"), "unchecked task");
        assert_eq!(derive_title("- [x] checked task"), "checked task");
        assert_eq!(derive_title("> quoted"), "quoted");
        assert_eq!(derive_title("> - [ ] quoted task"), "quoted task");
        assert_eq!(derive_title("## Closed heading ##"), "Closed heading");
    }

    #[test]
    fn title_leaves_content_that_merely_looks_like_syntax() {
        // Each of these would break if markers were stripped without requiring
        // the whitespace that actually makes them markers.
        assert_eq!(derive_title("#urgent follow-up"), "#urgent follow-up");
        assert_eq!(derive_title("*emphasis* first"), "*emphasis* first");
        assert_eq!(derive_title("-5 degrees outside"), "-5 degrees outside");
        assert_eq!(derive_title("3.5 inch floppy"), "3.5 inch floppy");
        assert_eq!(derive_title("####### seven hashes"), "####### seven hashes");
    }

    #[test]
    fn title_uses_the_first_non_empty_line() {
        assert_eq!(derive_title("\n\n  \n# Real title\nbody"), "Real title");
        assert_eq!(derive_title(""), "");
        assert_eq!(derive_title("   \n \n"), "");
    }

    #[test]
    fn writing_a_body_derives_the_title() {
        let e = engine();
        let node = e.create_node(None, "", None).unwrap();
        e.set_body(&node.id, "# August 22, 2026\n\nThings In Progress")
            .unwrap();
        assert_eq!(e.node(&node.id).unwrap().unwrap().title, "August 22, 2026");
    }

    #[test]
    fn the_derived_title_tracks_later_body_edits() {
        let e = engine();
        let node = e.create_node(None, "", None).unwrap();
        e.set_body(&node.id, "first version").unwrap();
        assert_eq!(e.node(&node.id).unwrap().unwrap().title, "first version");

        e.set_body(&node.id, "second version\nwith more").unwrap();
        assert_eq!(e.node(&node.id).unwrap().unwrap().title, "second version");
    }

    #[test]
    fn an_explicitly_set_title_survives_body_edits() {
        // `title` is an independent LWW field. Deriving it must never clobber a
        // title somebody set on purpose.
        let e = engine();
        let node = e.create_node(None, "", None).unwrap();
        e.set_body(&node.id, "auto from here").unwrap();

        e.set_title(&node.id, "Deliberate title").unwrap();
        e.set_body(&node.id, "body changed again").unwrap();

        assert_eq!(
            e.node(&node.id).unwrap().unwrap().title,
            "Deliberate title",
            "a hand-set title was overwritten by a body edit"
        );
    }

    #[test]
    fn clearing_the_body_clears_the_derived_title() {
        let e = engine();
        let node = e.create_node(None, "", None).unwrap();
        e.set_body(&node.id, "something").unwrap();
        e.set_body(&node.id, "").unwrap();
        assert_eq!(e.node(&node.id).unwrap().unwrap().title, "");
    }

    #[test]
    fn a_title_given_at_creation_is_not_derived_over() {
        let e = engine();
        let node = e.create_node(None, "Given up front", None).unwrap();
        e.set_body(&node.id, "unrelated body text").unwrap();
        assert_eq!(e.node(&node.id).unwrap().unwrap().title, "Given up front");
    }

    // -- diffing ------------------------------------------------------------

    #[test]
    fn text_change_computes_a_minimal_splice() {
        let mut body = YrsBody::new(1);
        apply_text_change(&mut body, "hello world").unwrap();
        assert_eq!(body.text(), "hello world");

        // Only the middle differs; prefix "hello " and suffix "d" are untouched.
        apply_text_change(&mut body, "hello cruel world").unwrap();
        assert_eq!(body.text(), "hello cruel world");

        apply_text_change(&mut body, "").unwrap();
        assert_eq!(body.text(), "");
    }
}
