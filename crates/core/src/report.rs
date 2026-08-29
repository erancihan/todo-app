//! The EOD report generator (docs/03-data-model.md §8).
//!
//! The report is **derived from the immutable event log**, never read off current
//! node state. Reading current state would answer "what is open?" — the report
//! has to answer "what happened today?", and only the log knows that.
//!
//! Written once here and shared verbatim by both hosts, like the rest of the
//! engine: a report generated in the browser and one generated on the desktop
//! from the same log are byte-identical.
//!
//! ## Timezone
//!
//! This module never guesses a timezone. The caller passes an explicit
//! `[from_ms, to_ms)` window and a `tz_offset_minutes`, because the host — a
//! browser or a Tauri WebView — is the only thing that actually knows the
//! viewer's local day boundary, and it knows it including DST. Core stays a pure
//! function of its inputs, which is what makes the output reproducible and the
//! tests honest (docs/03 §9: "Pin to user's local day; store HLC + UTC").

use serde::{Deserialize, Serialize};

use crate::engine::{Engine, EventView, NodeView};
use crate::node::StatusCategory;
use crate::store::{Store, StoreExt};
use crate::Result;

/// Which of the four buckets an item landed in (docs/03 §8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Bucket {
    Created,
    Updated,
    Completed,
    CarriedOver,
}

impl Bucket {
    fn rank(self) -> u8 {
        // Completed first: a report is read for what got finished.
        match self {
            Bucket::Completed => 0,
            Bucket::Created => 1,
            Bucket::Updated => 2,
            Bucket::CarriedOver => 3,
        }
    }
}

/// How the resolved items are pivoted into sections (docs/03 §8.3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Grouping {
    #[default]
    Collection,
    Tag,
    Flat,
}

/// Everything the generator needs that it cannot work out for itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportOptions {
    /// Start of the range, inclusive, in UTC milliseconds.
    pub from_ms: i64,
    /// End of the range, exclusive, in UTC milliseconds.
    pub to_ms: i64,
    /// Minutes to add to a UTC timestamp to reach the viewer's wall clock.
    pub tz_offset_minutes: i32,
    /// The heading date, already formatted by the host that owns the timezone.
    pub date_label: String,
    pub group_by: Grouping,
    /// List each item once under its primary collection instead of under every
    /// collection it belongs to (docs/03 §8.3).
    pub dedup: bool,
    /// How far back an untouched open item stays eligible to carry over.
    ///
    /// The doc's rule is "still open and in-scope (due before end, or touched
    /// earlier but unfinished)". Taken literally, "touched earlier" means every
    /// open todo ever created carries over forever, and the report becomes an
    /// inventory instead of a diff. The window bounds it: an item carries over
    /// while it is still recent, or for as long as it has a due date in play.
    pub carry_over_window_days: i64,
}

impl Default for ReportOptions {
    fn default() -> Self {
        Self {
            from_ms: 0,
            to_ms: 0,
            tz_offset_minutes: 0,
            date_label: String::new(),
            group_by: Grouping::default(),
            dedup: false,
            carry_over_window_days: 7,
        }
    }
}

/// One todo as it appears in the report.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportItem {
    pub node_id: String,
    pub title: String,
    /// The status id, its semantic category, and its display name — resolved at
    /// generation time so the markdown is stable even if statuses are renamed
    /// later (the report is a snapshot, not a live view).
    pub status: String,
    pub status_category: StatusCategory,
    pub status_name: String,
    pub bucket: Bucket,
    pub tags: Vec<String>,
    /// Nesting inside this section, rebased so the shallowest item sits at 0.
    pub depth: usize,
    pub completed_ms: Option<i64>,
    pub due_ms: Option<i64>,
    /// Promoted during this range — the `_(promoted today ↑)_` annotation.
    pub promoted_in_range: bool,
    /// How many previous reports carried this item forward.
    pub slipped_days: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSection {
    pub heading: String,
    pub items: Vec<ReportItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCounts {
    pub created: usize,
    pub updated: usize,
    pub completed: usize,
    pub carried_over: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub title: String,
    /// The deterministic markdown — the primary export (docs/03 §8.6).
    pub markdown: String,
    pub sections: Vec<ReportSection>,
    pub counts: ReportCounts,
    /// Node ids in the carried-over bucket, for [`Engine::commit_carry_over`].
    pub carried_over_ids: Vec<String>,
    /// Set when list-under-each duplicated items across collections, so the
    /// footer can say the totals count memberships rather than todos.
    pub duplicated: bool,
}

/// A day's worth of milliseconds.
const DAY_MS: i64 = 86_400_000;

/// `HH:MM` on the viewer's wall clock.
fn hhmm(ms: i64, tz_offset_minutes: i32) -> String {
    let local = ms + i64::from(tz_offset_minutes) * 60_000;
    // `rem_euclid` rather than `%`: a pre-1970 timestamp would otherwise produce
    // a negative hour, and the report would render "-3:-20".
    let minutes_into_day = local.rem_euclid(DAY_MS) / 60_000;
    format!("{:02}:{:02}", minutes_into_day / 60, minutes_into_day % 60)
}

/// The local calendar day a timestamp falls in, as `YYYY-MM-DD`.
///
/// Implemented here rather than with a date crate because the whole civil-date
/// calculation is a dozen lines and adding a dependency to format one string in
/// a wasm bundle is a poor trade. This is Howard Hinnant's `civil_from_days`.
pub fn day_key(ms: i64, tz_offset_minutes: i32) -> String {
    let local = ms + i64::from(tz_offset_minutes) * 60_000;
    let days = local.div_euclid(DAY_MS);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}")
}

/// What the events in range say happened to one node.
#[derive(Default)]
struct Touch {
    created: bool,
    completed: bool,
    reopened_after_completion: bool,
    promoted: bool,
    other: bool,
    completed_ms: Option<i64>,
}

impl Touch {
    fn apply(&mut self, event: &EventView) {
        match event.r#type.as_str() {
            // A `created` carrying `repeat_of` is a spawned occurrence of a
            // repeating todo — scheduling machinery, not work the user captured.
            // It must not appear under CREATED; if the user then actually
            // touches the spawn, those later events bucket it as usual.
            "created" => {
                if !event
                    .payload
                    .as_deref()
                    .is_some_and(|p| p.contains("repeat_of"))
                {
                    self.created = true;
                }
            }
            "completed" => {
                self.completed = true;
                self.reopened_after_completion = false;
                self.completed_ms = Some(event.occurred_ms);
            }
            "reopened" => {
                if self.completed {
                    self.reopened_after_completion = true;
                }
                self.other = true;
            }
            "promoted" => {
                self.promoted = true;
                self.other = true;
            }
            _ => self.other = true,
        }
    }

    /// Completion wins over creation: a todo captured and finished in the same
    /// day belongs in COMPLETED, which is the line the reader cares about.
    fn bucket(&self) -> Option<Bucket> {
        if self.completed && !self.reopened_after_completion {
            return Some(Bucket::Completed);
        }
        if self.created {
            return Some(Bucket::Created);
        }
        if self.other || self.completed {
            return Some(Bucket::Updated);
        }
        None
    }
}

impl<S: Store> Engine<S> {
    /// Generate a report for `[from_ms, to_ms)`.
    ///
    /// Pure: it reads the log and the current tree and writes nothing. Carry-over
    /// events are appended by [`Engine::commit_carry_over`] as a separate,
    /// explicit step, because generating a report twice must not double the
    /// slipped-days count of every open item.
    pub fn generate_report(&self, options: &ReportOptions) -> Result<Report> {
        let nodes = self.list_tree()?;
        let events = self.events_between(options.from_ms, options.to_ms)?;
        let slipped = self.carry_over_counts()?;
        let last_touch = self.last_event_ms()?;
        // Names resolved once: renaming a status later must not rewrite what an
        // already-generated report said.
        let status_names: Vec<(String, String)> = self
            .list_statuses()?
            .into_iter()
            .map(|s| (s.id, s.name))
            .collect();
        let default_open = self.default_open_status_id()?;

        // -- 1-3: resolve events to snapshots and bucket them -----------------
        let mut touches: Vec<(String, Touch)> = Vec::new();
        for event in &events {
            // `carried_over` is the report's own bookkeeping, not something the
            // user did. Counting it as a touch would move an item out of the
            // carried-over bucket the day after it first slipped, and it would
            // never slip again — the slipped-days count could only ever read 1.
            if event.r#type == "carried_over" {
                continue;
            }
            match touches.iter_mut().find(|(id, _)| *id == event.node_id) {
                Some((_, touch)) => touch.apply(event),
                None => {
                    let mut touch = Touch::default();
                    touch.apply(event);
                    touches.push((event.node_id.clone(), touch));
                }
            }
        }

        let by_id = |id: &str| nodes.iter().find(|n| n.id == id);
        let mut items: Vec<ReportItem> = Vec::new();

        for (node_id, touch) in &touches {
            // A node deleted since the events were written has no snapshot to
            // resolve against; the log still remembers it, the report cannot
            // show it.
            let Some(node) = by_id(node_id) else { continue };
            let Some(bucket) = touch.bucket() else {
                continue;
            };
            items.push(item_from(node, bucket, touch, &slipped, &status_names));
        }

        // -- carried over: open, untouched in range, still in scope -----------
        let window_start = options.from_ms - options.carry_over_window_days * DAY_MS;
        for node in &nodes {
            if touches.iter().any(|(id, _)| id == &node.id) {
                continue;
            }
            if !is_open(node.status_category) {
                continue;
            }
            let due_in_play = node.due_at.is_some_and(|due| due < options.to_ms);
            // From the log, not from `node.updated_at` — see `last_event_ms`.
            // Strictly *before* the range: "touched earlier but unfinished".
            let touched = last_touch
                .iter()
                .find(|(id, _)| id == &node.id)
                .map(|(_, ms)| *ms)
                .unwrap_or(node.updated_at);
            let recently_alive = touched >= window_start && touched < options.from_ms;
            if !due_in_play && !recently_alive {
                continue;
            }
            items.push(item_from(
                node,
                Bucket::CarriedOver,
                &Touch::default(),
                &slipped,
                &status_names,
            ));
        }

        let counts = ReportCounts {
            created: items.iter().filter(|i| i.bucket == Bucket::Created).count(),
            updated: items.iter().filter(|i| i.bucket == Bucket::Updated).count(),
            completed: items
                .iter()
                .filter(|i| i.bucket == Bucket::Completed)
                .count(),
            carried_over: items
                .iter()
                .filter(|i| i.bucket == Bucket::CarriedOver)
                .count(),
        };
        let carried_over_ids = items
            .iter()
            .filter(|i| i.bucket == Bucket::CarriedOver)
            .map(|i| i.node_id.clone())
            .collect();

        // -- 4: group -------------------------------------------------------
        let (sections, duplicated) = self.group(&items, &nodes, options)?;

        let title = format!("EOD — {}", options.date_label);
        let markdown = render(
            &title,
            &sections,
            &counts,
            duplicated,
            options,
            &default_open,
        );

        Ok(Report {
            title,
            markdown,
            sections,
            counts,
            carried_over_ids,
            duplicated,
        })
    }

    /// Append one `carried_over` event per node for `day_key`, skipping any node
    /// that already has one for that day.
    ///
    /// Idempotent on purpose: the report is generated every time the view opens,
    /// and without the guard a slow afternoon of re-checking today's report would
    /// read back tomorrow as "slipped 14 days".
    pub fn commit_carry_over(&self, node_ids: &[String], day_key: &str) -> Result<usize> {
        let mut written = 0;
        for node_id in node_ids {
            let already = self.store().query_i64(
                "SELECT COUNT(*) FROM event WHERE account_id = ? AND node_id = ? \
                 AND type = 'carried_over' AND payload = ?",
                &[
                    self.account_value(),
                    node_id.as_str().into(),
                    day_key.into(),
                ],
            )?;
            if already.unwrap_or(0) > 0 {
                continue;
            }
            self.emit_carry_over(node_id, day_key)?;
            written += 1;
        }
        Ok(written)
    }

    fn group(
        &self,
        items: &[ReportItem],
        nodes: &[NodeView],
        options: &ReportOptions,
    ) -> Result<(Vec<ReportSection>, bool)> {
        let mut duplicated = false;
        let mut sections: Vec<ReportSection> = Vec::new();

        // (heading, node_id) pairs, in the order headings should appear.
        let mut placements: Vec<(String, String)> = Vec::new();

        // Membership is per-node, but a sub-item belongs where its parent
        // belongs. Without this a checklist under a filed todo scatters into
        // "Uncollected" and the rollup the report exists to show — these three
        // steps of that one job — reads as three unrelated jobs.
        let inherited = |item: &ReportItem, own: Vec<String>, of: &dyn Fn(&str) -> Vec<String>| {
            if !own.is_empty() {
                return own;
            }
            let mut cursor = nodes
                .iter()
                .find(|n| n.id == item.node_id)
                .and_then(|n| n.parent_id.clone());
            while let Some(parent) = cursor {
                // Only inherit from an ancestor that is itself in the report, or
                // the item lands under a heading with no visible parent to sit
                // beneath.
                if items.iter().any(|i| i.node_id == parent) {
                    let from_parent = of(&parent);
                    if !from_parent.is_empty() {
                        return from_parent;
                    }
                }
                cursor = nodes
                    .iter()
                    .find(|n| n.id == parent)
                    .and_then(|n| n.parent_id.clone());
            }
            Vec::new()
        };

        match options.group_by {
            Grouping::Flat => {
                for item in items {
                    placements.push((String::new(), item.node_id.clone()));
                }
            }
            Grouping::Tag => {
                for item in items {
                    if item.tags.is_empty() {
                        placements.push(("Untagged".into(), item.node_id.clone()));
                        continue;
                    }
                    if options.dedup {
                        placements.push((format!("#{}", item.tags[0]), item.node_id.clone()));
                    } else {
                        if item.tags.len() > 1 {
                            duplicated = true;
                        }
                        for tag in &item.tags {
                            placements.push((format!("#{tag}"), item.node_id.clone()));
                        }
                    }
                }
            }
            Grouping::Collection => {
                let collections = self.list_collections()?;
                let name_of = |id: &str| {
                    collections
                        .iter()
                        .find(|c| c.id == id)
                        .map(|c| c.name.clone())
                        .unwrap_or_else(|| "Collection".into())
                };
                let collections_of = |id: &str| {
                    nodes
                        .iter()
                        .find(|n| n.id == id)
                        .map(|n| n.collection_ids.clone())
                        .unwrap_or_default()
                };
                for item in items {
                    let memberships =
                        inherited(item, collections_of(&item.node_id), &collections_of);
                    if memberships.is_empty() {
                        placements.push(("Uncollected".into(), item.node_id.clone()));
                        continue;
                    }
                    if options.dedup {
                        placements.push((name_of(&memberships[0]), item.node_id.clone()));
                    } else {
                        if memberships.len() > 1 {
                            duplicated = true;
                        }
                        for id in &memberships {
                            placements.push((name_of(id), item.node_id.clone()));
                        }
                    }
                }
            }
        }

        // Headings in first-seen order, so the output is stable across runs.
        let mut headings: Vec<String> = Vec::new();
        for (heading, _) in &placements {
            if !headings.contains(heading) {
                headings.push(heading.clone());
            }
        }
        headings.sort_by(|a, b| {
            // "Uncollected"/"Untagged" last: they are the leftovers, not a topic.
            let rank = |h: &str| u8::from(h == "Uncollected" || h == "Untagged");
            rank(a).cmp(&rank(b)).then_with(|| a.cmp(b))
        });

        for heading in headings {
            let ids: Vec<&str> = placements
                .iter()
                .filter(|(h, _)| *h == heading)
                .map(|(_, id)| id.as_str())
                .collect();
            let mut section_items: Vec<ReportItem> = items
                .iter()
                .filter(|i| ids.contains(&i.node_id.as_str()))
                .cloned()
                .collect();
            nest(&mut section_items, nodes);
            sections.push(ReportSection {
                heading,
                items: section_items,
            });
        }

        Ok((sections, duplicated))
    }
}

fn is_open(category: StatusCategory) -> bool {
    category == StatusCategory::Open
}

fn item_from(
    node: &NodeView,
    bucket: Bucket,
    touch: &Touch,
    slipped: &[(String, i64)],
    status_names: &[(String, String)],
) -> ReportItem {
    ReportItem {
        node_id: node.id.clone(),
        title: node.title.clone(),
        status: node.status.clone(),
        status_category: node.status_category,
        // Falls back to the id itself — readable enough for a status that was
        // deleted while nodes still carried it.
        status_name: status_names
            .iter()
            .find(|(id, _)| id == &node.status)
            .map(|(_, name)| name.clone())
            .unwrap_or_else(|| node.status.clone()),
        bucket,
        tags: node.tags.iter().map(|t| t.name.clone()).collect(),
        depth: 0,
        completed_ms: touch.completed_ms.or(node.completed_at),
        due_ms: node.due_at,
        promoted_in_range: touch.promoted,
        slipped_days: slipped
            .iter()
            .find(|(id, _)| id == &node.id)
            .map(|(_, n)| *n)
            .unwrap_or(0),
    }
}

/// Order a section so children follow their parents, and rebase depth.
///
/// Without this a sub-item that changed today would print as a sibling of its
/// parent, and the checklist rollup the report is meant to show — "these three
/// steps of that one job" — reads as three unrelated jobs.
fn nest(items: &mut [ReportItem], nodes: &[NodeView]) {
    let parent_of = |id: &str| {
        nodes
            .iter()
            .find(|n| n.id == id)
            .and_then(|n| n.parent_id.clone())
    };
    let order_of = |id: &str| nodes.iter().position(|n| n.id == id).unwrap_or(usize::MAX);

    // Tree order first, so a parent always precedes its descendants.
    items.sort_by_key(|i| order_of(&i.node_id));

    let present: Vec<String> = items.iter().map(|i| i.node_id.clone()).collect();

    for item in items.iter_mut() {
        // Depth relative to the nearest ancestor that is *also* in this section.
        // Using absolute depth would indent an orphaned grandchild three levels
        // under nothing.
        let mut depth = 0;
        let mut cursor = parent_of(&item.node_id);
        while let Some(parent) = cursor {
            if present.contains(&parent) {
                depth += 1;
            }
            cursor = parent_of(&parent);
        }
        // No ancestor in this section means top level here, whatever its
        // absolute depth in the tree.
        item.depth = depth;
    }

    // Then by bucket within each top-level run, so completed work leads.
    items.sort_by(|a, b| {
        if a.depth > 0 || b.depth > 0 {
            return order_of(&a.node_id).cmp(&order_of(&b.node_id));
        }
        a.bucket
            .rank()
            .cmp(&b.bucket.rank())
            .then_with(|| order_of(&a.node_id).cmp(&order_of(&b.node_id)))
    });
}

/// Render the markdown (docs/03 §8.4).
fn render(
    title: &str,
    sections: &[ReportSection],
    counts: &ReportCounts,
    duplicated: bool,
    options: &ReportOptions,
    default_open: &str,
) -> String {
    let mut out = format!("# {title}\n");

    let empty = sections.iter().all(|s| s.items.is_empty());
    if empty {
        out.push_str("\n_Nothing recorded in this range._\n");
        return out;
    }

    for section in sections {
        if section.items.is_empty() {
            continue;
        }
        if !section.heading.is_empty() {
            out.push_str(&format!("\n## {}\n", section.heading));
        } else {
            out.push('\n');
        }
        for item in &section.items {
            out.push_str(&render_item(item, options, default_open));
        }
    }

    out.push_str(&format!(
        "\n_Created {} · Updated {} · Completed {} · Carried over {}_\n",
        counts.created, counts.updated, counts.completed, counts.carried_over
    ));
    if duplicated {
        out.push_str(
            "_Items in several collections are listed under each; totals count memberships._\n",
        );
    }
    out
}

fn render_item(item: &ReportItem, options: &ReportOptions, options_default_open: &str) -> String {
    let indent = "  ".repeat(item.depth);
    let box_mark = if item.status_category == StatusCategory::Done {
        "x"
    } else {
        " "
    };

    // Top-level titles are bold, sub-items are not — the same weight difference
    // the list itself uses between a todo and its checklist.
    let title = if item.title.trim().is_empty() {
        "Untitled".to_owned()
    } else if item.depth == 0 {
        format!("**{}**", item.title)
    } else {
        item.title.clone()
    };

    let mut line = format!("{indent}- [{box_mark}] {title}");

    for tag in &item.tags {
        line.push_str(&format!("  `#{tag}`"));
    }
    if let Some(due) = item.due_ms {
        line.push_str(&format!(" · due {}", hhmm(due, options.tz_offset_minutes)));
    }
    if item.bucket == Bucket::Completed {
        if let Some(done) = item.completed_ms {
            line.push_str(&format!(
                " · done {}",
                hhmm(done, options.tz_offset_minutes)
            ));
        }
    }
    if item.promoted_in_range {
        line.push_str(" _(promoted today ↑)_");
    }
    if item.bucket == Bucket::CarriedOver {
        if item.slipped_days > 0 {
            line.push_str(&format!(
                " — _carried over (slipped {} day{})_",
                item.slipped_days,
                if item.slipped_days == 1 { "" } else { "s" }
            ));
        } else {
            line.push_str(" — _carried over_");
        }
    } else if item.bucket != Bucket::Completed
        && item.status_category != StatusCategory::Done
        && item.status != options_default_open
    {
        // Any non-default status is worth a word — that is what the user made
        // it for. The *name* renders, lowercased, so "Waiting" reads as prose.
        line.push_str(&format!(" _{}_", item.status_name.to_lowercase()));
    }

    line.push('\n');
    line
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::ids::DeviceId;
    use crate::store::SqliteStore;

    /// The host-resolved civil day every completion in these tests happens on.
    const TODAY: &str = "2026-01-05";

    fn engine() -> Engine<SqliteStore> {
        Engine::open(
            SqliteStore::in_memory().unwrap(),
            "acct-report",
            DeviceId::from("device-report-01"),
        )
        .unwrap()
    }

    /// A window wide enough to hold everything the test just did.
    fn today(e: &Engine<SqliteStore>) -> ReportOptions {
        let now = e.now_for_test();
        ReportOptions {
            from_ms: now - DAY_MS,
            to_ms: now + DAY_MS,
            tz_offset_minutes: 0,
            date_label: "2026-07-09".into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_captured_todo_lands_in_created() {
        let e = engine();
        e.create_node(None, "Ship the report", None).unwrap();

        let report = e.generate_report(&today(&e)).unwrap();
        assert_eq!(report.counts.created, 1);
        assert_eq!(report.counts.completed, 0);
        assert!(report.markdown.contains("- [ ] **Ship the report**"));
        assert!(report.markdown.starts_with("# EOD — 2026-07-09\n"));
    }

    #[test]
    fn completing_a_todo_beats_creating_it() {
        let e = engine();
        let node = e.create_node(None, "Fix the backoff", None).unwrap();
        e.toggle_done(&node.id, TODAY).unwrap();

        let report = e.generate_report(&today(&e)).unwrap();
        // Captured and finished in one day is a completion, not a creation —
        // that is the line anyone reading the report cares about.
        assert_eq!(report.counts.completed, 1);
        assert_eq!(report.counts.created, 0);
        assert!(report.markdown.contains("- [x] **Fix the backoff**"));
        assert!(report.markdown.contains(" · done "));
    }

    #[test]
    fn completing_then_reopening_is_an_update() {
        let e = engine();
        let node = e.create_node(None, "Half done", None).unwrap();
        e.toggle_done(&node.id, TODAY).unwrap();
        e.toggle_done(&node.id, TODAY).unwrap();

        let report = e.generate_report(&today(&e)).unwrap();
        assert_eq!(
            report.counts.completed, 0,
            "reopened item still counted done"
        );
        assert_eq!(report.counts.created, 1);
    }

    #[test]
    fn a_spawned_occurrence_is_not_todays_news() {
        let e = engine();
        let node = e.create_node(None, "Water the plants", None).unwrap();
        e.set_repeat(&node.id, Some("every week")).unwrap();
        e.toggle_done(&node.id, TODAY).unwrap().expect("no spawn");

        let report = e.generate_report(&today(&e)).unwrap();
        // The day's story is "watered the plants", full stop. The next
        // occurrence is scheduling machinery — counting it under CREATED would
        // make every repeating chore read as new work, every single day.
        assert_eq!(report.counts.completed, 1);
        assert_eq!(report.counts.created, 0);
    }

    #[test]
    fn work_from_an_earlier_day_is_not_todays_news() {
        let e = engine();
        e.create_node(None, "Yesterday", None).unwrap();

        let now = e.now_for_test();
        let options = ReportOptions {
            from_ms: now + DAY_MS,
            to_ms: now + 2 * DAY_MS,
            date_label: "tomorrow".into(),
            ..Default::default()
        };
        let report = e.generate_report(&options).unwrap();
        // Created before the range, so not CREATED — but still open and recent,
        // which is exactly what carry-over is for.
        assert_eq!(report.counts.created, 0);
        assert_eq!(report.counts.carried_over, 1);
    }

    #[test]
    fn an_empty_range_says_so_instead_of_rendering_a_bare_heading() {
        let e = engine();
        let report = e.generate_report(&today(&e)).unwrap();
        assert!(report.sections.is_empty());
        assert!(report.markdown.contains("Nothing recorded in this range."));
    }

    #[test]
    fn sub_items_nest_under_the_parent_they_belong_to() {
        let e = engine();
        let root = e.create_node(None, "Ship the report", None).unwrap();
        let child = e
            .create_node(Some(&root.id), "Query the log", None)
            .unwrap();
        e.toggle_done(&child.id, TODAY).unwrap();

        let report = e.generate_report(&today(&e)).unwrap();
        let lines: Vec<&str> = report
            .markdown
            .lines()
            .filter(|l| l.contains("- ["))
            .collect();
        assert_eq!(lines.len(), 2);
        assert!(
            lines[0].starts_with("- ["),
            "parent was indented: {:?}",
            lines[0]
        );
        assert!(
            lines[1].starts_with("  - [x] Query the log"),
            "child not nested: {:?}",
            lines[1]
        );
    }

    #[test]
    fn an_orphaned_sub_item_is_not_indented_under_nothing() {
        let e = engine();
        let root = e.create_node(None, "Parent", None).unwrap();
        let child = e.create_node(Some(&root.id), "Child", None).unwrap();

        // Only the child is in range, so it is the shallowest thing present.
        // `carry_over_window_days: 0` keeps the parent out entirely, which is
        // what makes this a test of nesting rather than of carry-over.
        let child_events = e.events_for_node(&child.id).unwrap();
        let start = child_events.first().unwrap().occurred_ms;
        let options = ReportOptions {
            from_ms: start,
            to_ms: start + DAY_MS,
            date_label: "d".into(),
            carry_over_window_days: 0,
            ..Default::default()
        };
        let report = e.generate_report(&options).unwrap();
        assert!(!report.sections.is_empty());
        let item = &report.sections[0].items[0];
        assert_eq!(item.node_id, child.id);
        assert_eq!(item.depth, 0, "indented under a parent that is not shown");
        let _ = root;
    }

    #[test]
    fn collections_become_headings_and_the_rest_is_uncollected() {
        let e = engine();
        let work = e.create_collection("Work", None).unwrap();
        let filed = e.create_node(None, "Filed", None).unwrap();
        e.add_to_collection(&filed.id, &work.id).unwrap();
        e.create_node(None, "Loose", None).unwrap();

        let report = e.generate_report(&today(&e)).unwrap();
        let headings: Vec<&str> = report.sections.iter().map(|s| s.heading.as_str()).collect();
        // "Uncollected" is the leftovers, so it sorts last however it is named.
        assert_eq!(headings, ["Work", "Uncollected"]);
    }

    #[test]
    fn a_sub_item_is_filed_where_its_parent_is() {
        let e = engine();
        let work = e.create_collection("Work", None).unwrap();
        let root = e.create_node(None, "Ship the report", None).unwrap();
        e.add_to_collection(&root.id, &work.id).unwrap();
        let child = e
            .create_node(Some(&root.id), "Query the log", None)
            .unwrap();
        e.toggle_done(&child.id, TODAY).unwrap();

        let report = e.generate_report(&today(&e)).unwrap();
        let headings: Vec<&str> = report.sections.iter().map(|s| s.heading.as_str()).collect();
        // Membership is per-node, so the child has none of its own — but filing
        // it under "Uncollected" would break the parent's checklist in half.
        assert_eq!(headings, ["Work"]);
        assert!(
            report.markdown.contains("\n  - [x] Query the log"),
            "sub-item did not nest under its parent: {}",
            report.markdown
        );
    }

    #[test]
    fn a_sub_item_filed_somewhere_else_keeps_its_own_home() {
        let e = engine();
        let work = e.create_collection("Work", None).unwrap();
        let home = e.create_collection("Home", None).unwrap();
        let root = e.create_node(None, "Parent", None).unwrap();
        e.add_to_collection(&root.id, &work.id).unwrap();
        let child = e.create_node(Some(&root.id), "Child", None).unwrap();
        e.add_to_collection(&child.id, &home.id).unwrap();

        let report = e.generate_report(&today(&e)).unwrap();
        let home_items: Vec<&str> = report
            .sections
            .iter()
            .find(|s| s.heading == "Home")
            .map(|s| s.items.iter().map(|i| i.title.as_str()).collect())
            .unwrap_or_default();
        // Inheritance is a fallback, not an override.
        assert_eq!(home_items, ["Child"]);
    }

    #[test]
    fn list_under_each_repeats_a_multi_collection_item() {
        let e = engine();
        let work = e.create_collection("Work", None).unwrap();
        let home = e.create_collection("Home", None).unwrap();
        let node = e.create_node(None, "Both", None).unwrap();
        e.add_to_collection(&node.id, &work.id).unwrap();
        e.add_to_collection(&node.id, &home.id).unwrap();

        let report = e.generate_report(&today(&e)).unwrap();
        let appearances: usize = report
            .sections
            .iter()
            .map(|s| s.items.iter().filter(|i| i.node_id == node.id).count())
            .sum();
        assert_eq!(appearances, 2);
        assert!(report.duplicated, "duplication was not disclosed");
        assert!(report.markdown.contains("totals count memberships"));
    }

    #[test]
    fn dedup_lists_a_multi_collection_item_once() {
        let e = engine();
        let work = e.create_collection("Work", None).unwrap();
        let home = e.create_collection("Home", None).unwrap();
        let node = e.create_node(None, "Both", None).unwrap();
        e.add_to_collection(&node.id, &work.id).unwrap();
        e.add_to_collection(&node.id, &home.id).unwrap();

        let options = ReportOptions {
            dedup: true,
            ..today(&e)
        };
        let report = e.generate_report(&options).unwrap();
        let appearances: usize = report
            .sections
            .iter()
            .map(|s| s.items.iter().filter(|i| i.node_id == node.id).count())
            .sum();
        assert_eq!(appearances, 1);
        assert!(!report.duplicated);
    }

    #[test]
    fn an_untouched_open_todo_carries_over() {
        let e = engine();
        let node = e.create_node(None, "Call the contractor", None).unwrap();
        let created = e.node(&node.id).unwrap().unwrap().updated_at;

        // A range that starts after the todo was last touched.
        let options = ReportOptions {
            from_ms: created + 1,
            to_ms: created + DAY_MS,
            date_label: "d".into(),
            ..Default::default()
        };
        let report = e.generate_report(&options).unwrap();
        assert_eq!(report.counts.carried_over, 1);
        assert!(report.markdown.contains("— _carried over_"));
        assert_eq!(report.carried_over_ids, vec![node.id]);
    }

    #[test]
    fn a_finished_todo_never_carries_over() {
        let e = engine();
        let node = e.create_node(None, "Done thing", None).unwrap();
        e.toggle_done(&node.id, TODAY).unwrap();
        let touched = e.node(&node.id).unwrap().unwrap().updated_at;

        let options = ReportOptions {
            from_ms: touched + 1,
            to_ms: touched + DAY_MS,
            date_label: "d".into(),
            ..Default::default()
        };
        let report = e.generate_report(&options).unwrap();
        assert_eq!(report.counts.carried_over, 0);
    }

    #[test]
    fn a_stale_open_todo_falls_out_of_the_carry_over_window() {
        let e = engine();
        let node = e.create_node(None, "Ancient", None).unwrap();
        let touched = e.node(&node.id).unwrap().unwrap().updated_at;

        let options = ReportOptions {
            from_ms: touched + 30 * DAY_MS,
            to_ms: touched + 31 * DAY_MS,
            date_label: "d".into(),
            carry_over_window_days: 7,
            ..Default::default()
        };
        let report = e.generate_report(&options).unwrap();
        assert_eq!(
            report.counts.carried_over, 0,
            "a month-old untouched todo is inventory, not today's news"
        );
        let _ = node;
    }

    #[test]
    fn commit_carry_over_is_idempotent_within_a_day() {
        let e = engine();
        let node = e.create_node(None, "Slippy", None).unwrap();

        assert_eq!(
            e.commit_carry_over(std::slice::from_ref(&node.id), "2026-07-09")
                .unwrap(),
            1
        );
        assert_eq!(
            e.commit_carry_over(std::slice::from_ref(&node.id), "2026-07-09")
                .unwrap(),
            0,
            "re-opening today's report bumped the slipped count"
        );
        assert_eq!(
            e.commit_carry_over(std::slice::from_ref(&node.id), "2026-07-10")
                .unwrap(),
            1
        );
    }

    #[test]
    fn slipped_days_shows_in_the_markdown() {
        let e = engine();
        let node = e.create_node(None, "Call the contractor", None).unwrap();
        e.commit_carry_over(std::slice::from_ref(&node.id), "2026-07-07")
            .unwrap();
        e.commit_carry_over(std::slice::from_ref(&node.id), "2026-07-08")
            .unwrap();
        let touched = e.node(&node.id).unwrap().unwrap().updated_at;

        let options = ReportOptions {
            from_ms: touched + 1,
            to_ms: touched + DAY_MS,
            date_label: "d".into(),
            ..Default::default()
        };
        let report = e.generate_report(&options).unwrap();
        assert!(
            report.markdown.contains("slipped 2 days"),
            "got: {}",
            report.markdown
        );
    }

    #[test]
    fn the_same_log_renders_the_same_markdown_twice() {
        let e = engine();
        let work = e.create_collection("Work", None).unwrap();
        for i in 0..5 {
            let n = e.create_node(None, &format!("Task {i}"), None).unwrap();
            e.add_to_collection(&n.id, &work.id).unwrap();
            e.add_tag(&n.id, &format!("tag{}", i % 2)).unwrap();
            if i % 2 == 0 {
                e.toggle_done(&n.id, TODAY).unwrap();
            }
        }
        let options = today(&e);
        assert_eq!(
            e.generate_report(&options).unwrap().markdown,
            e.generate_report(&options).unwrap().markdown,
            "the report is supposed to be deterministic"
        );
    }

    #[test]
    fn hhmm_is_local_and_survives_a_negative_offset() {
        // 1970-01-01T12:00Z
        assert_eq!(hhmm(12 * 3_600_000, 0), "12:00");
        assert_eq!(hhmm(12 * 3_600_000, -8 * 60), "04:00");
        // Crossing back over midnight must wrap, not go negative.
        assert_eq!(hhmm(2 * 3_600_000, -8 * 60), "18:00");
    }

    #[test]
    fn day_key_matches_the_civil_calendar() {
        assert_eq!(day_key(0, 0), "1970-01-01");
        // 2026-08-23T00:00:00Z
        assert_eq!(day_key(1_787_443_200_000, 0), "2026-08-23");
        // An hour earlier in UTC is still the 22nd on a UTC-2 clock.
        assert_eq!(day_key(1_787_443_200_000, -120), "2026-08-22");
        // Leap day.
        assert_eq!(day_key(1_709_164_800_000, 0), "2024-02-29");
    }

    #[test]
    fn grouping_by_tag_pivots_the_same_snapshots() {
        let e = engine();
        let node = e.create_node(None, "Tagged thing", None).unwrap();
        e.add_tag(&node.id, "urgent").unwrap();
        e.create_node(None, "Bare thing", None).unwrap();

        let options = ReportOptions {
            group_by: Grouping::Tag,
            ..today(&e)
        };
        let report = e.generate_report(&options).unwrap();
        let headings: Vec<&str> = report.sections.iter().map(|s| s.heading.as_str()).collect();
        assert_eq!(headings, ["#urgent", "Untagged"]);
    }

    #[test]
    fn a_flat_report_has_one_unnamed_section() {
        let e = engine();
        e.create_node(None, "One", None).unwrap();
        let options = ReportOptions {
            group_by: Grouping::Flat,
            ..today(&e)
        };
        let report = e.generate_report(&options).unwrap();
        assert_eq!(report.sections.len(), 1);
        assert_eq!(report.sections[0].heading, "");
        assert!(!report.markdown.contains("##"));
    }
}
