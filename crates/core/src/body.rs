//! Body CRDT — the markdown body of a NODE, and the only field that gets a real
//! sequence CRDT (docs/02-architecture.md ADR-002, docs/03-data-model.md §5.1).
//!
//! Everything else on a NODE merges by HLC-stamped per-field LWW. The body earns
//! a sequence CRDT because character-level loss on a long markdown body is the one
//! merge failure that feels broken.
//!
//! `yrs` was still closing feature parity with Yjs in mid-2026 (roadmap risk #4),
//! so the engine sits behind [`BodyCrdt`] and every wire value is an opaque byte
//! blob ([`BodyUpdate`], [`StateVector`]). Swapping in Loro or automerge means
//! writing one more impl of this trait — no caller changes.

use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{GetString, ReadTxn, Text, TextRef, Transact};

use crate::{CoreError, Result};

/// The name of the single `Y.Text` inside a body document. One `Y.Text` per NODE
/// body — `y-codemirror.next` binds the editor to exactly this.
pub const BODY_TEXT_KEY: &str = "body";

/// An opaque, engine-specific CRDT update. Travels the op log as a `body_update`
/// op (docs/02-architecture.md §4.1). Callers never inspect the bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyUpdate(pub Vec<u8>);

impl BodyUpdate {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// An opaque, engine-specific causal summary of what a replica has already seen.
/// A peer sends this to ask "give me only what I'm missing".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateVector(pub Vec<u8>);

impl StateVector {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

/// The swappable body-CRDT seam.
///
/// The contract every implementation must honor — these are the properties the
/// op log relies on, and the properties the Phase 0 tests below assert:
///
/// * **Convergence** — two replicas that have exchanged each other's updates hold
///   identical text, regardless of the order the updates arrived in.
/// * **Idempotence** — applying the same update twice changes nothing.
/// * **Round-trip** — a snapshot and a state vector survive encode → decode.
pub trait BodyCrdt: Sized {
    /// A fresh, empty body owned by `client_id` (the device's CRDT identity).
    fn new(client_id: u64) -> Self;

    /// Rebuild a body from a previously encoded snapshot.
    fn from_snapshot(client_id: u64, snapshot: &BodyUpdate) -> Result<Self>;

    /// The body as a literal markdown string — what the report concatenates and
    /// what the SQLite projection stores.
    fn text(&self) -> String;

    /// Insert `chunk` at UTF-16 offset `index` (the offset space CodeMirror uses).
    fn insert(&mut self, index: u32, chunk: &str) -> Result<()>;

    /// Delete `len` units starting at UTF-16 offset `index`.
    fn remove(&mut self, index: u32, len: u32) -> Result<()>;

    /// What this replica has observed — send to a peer to request a delta.
    fn state_vector(&self) -> StateVector;

    /// Everything this replica knows that a peer at `since` does not.
    fn diff(&self, since: &StateVector) -> Result<BodyUpdate>;

    /// The full state, as an update from nothing. Suitable for cold storage.
    fn snapshot(&self) -> Result<BodyUpdate> {
        self.diff(&StateVector(yrs::StateVector::default().encode_v1()))
    }

    /// Merge a peer's update. Must be commutative and idempotent.
    fn apply(&mut self, update: &BodyUpdate) -> Result<()>;
}

/// The shipped implementation: Yjs `Y.Text` via `yrs`.
///
/// Chosen over Loro because `y-codemirror.next` is the most-proven
/// CodeMirror↔CRDT binding, and the node tree is LWW `parent_id` + fractional
/// index, so Loro's movable-tree CRDT buys us nothing (ADR-002).
pub struct YrsBody {
    doc: yrs::Doc,
    text: TextRef,
}

impl YrsBody {
    /// The `yrs` client id this replica writes under.
    pub fn client_id(&self) -> u64 {
        self.doc.client_id().get()
    }

    fn build(doc: yrs::Doc) -> Self {
        let text = doc.get_or_insert_text(BODY_TEXT_KEY);
        Self { doc, text }
    }

    fn doc_with_id(client_id: u64) -> yrs::Doc {
        yrs::Doc::with_options(yrs::Options {
            // yrs client ids are 53-bit (JavaScript-safe); mask so a caller
            // passing a full u64 device hash cannot trip the internal assert.
            client_id: yrs::ClientID::new(client_id & ((1u64 << 53) - 1)),
            ..Default::default()
        })
    }
}

impl BodyCrdt for YrsBody {
    fn new(client_id: u64) -> Self {
        Self::build(Self::doc_with_id(client_id))
    }

    fn from_snapshot(client_id: u64, snapshot: &BodyUpdate) -> Result<Self> {
        let mut body = Self::new(client_id);
        body.apply(snapshot)?;
        Ok(body)
    }

    fn text(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }

    fn insert(&mut self, index: u32, chunk: &str) -> Result<()> {
        let mut txn = self.doc.transact_mut();
        self.text.insert(&mut txn, index, chunk);
        Ok(())
    }

    fn remove(&mut self, index: u32, len: u32) -> Result<()> {
        let mut txn = self.doc.transact_mut();
        self.text.remove_range(&mut txn, index, len);
        Ok(())
    }

    fn state_vector(&self) -> StateVector {
        StateVector(self.doc.transact().state_vector().encode_v1())
    }

    fn diff(&self, since: &StateVector) -> Result<BodyUpdate> {
        let sv = yrs::StateVector::decode_v1(since.as_bytes())
            .map_err(|e| CoreError::Codec(format!("state vector decode: {e}")))?;
        Ok(BodyUpdate(
            self.doc.transact().encode_state_as_update_v1(&sv),
        ))
    }

    fn apply(&mut self, update: &BodyUpdate) -> Result<()> {
        let update = yrs::Update::decode_v1(update.as_bytes())
            .map_err(|e| CoreError::Codec(format!("update decode: {e}")))?;
        self.doc
            .transact_mut()
            .apply_update(update)
            .map_err(|e| CoreError::Crdt(format!("apply update: {e}")))
    }
}

// ---------------------------------------------------------------------------
// Phase 0 exit criterion:
//   "yrs round-trips a concurrent Y.Text edit to convergence; snapshot + update
//    encode/decode verified in a unit test."   — docs/05-roadmap.md
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE_A: u64 = 1;
    const DEVICE_B: u64 = 2;

    /// Exchange every update each side is missing, in both directions.
    fn sync(a: &mut YrsBody, b: &mut YrsBody) {
        let a_to_b = a.diff(&b.state_vector()).unwrap();
        let b_to_a = b.diff(&a.state_vector()).unwrap();
        b.apply(&a_to_b).unwrap();
        a.apply(&b_to_a).unwrap();
    }

    #[test]
    fn concurrent_offline_edits_converge_without_losing_characters() {
        // Both devices start from the same committed body.
        let mut a = YrsBody::new(DEVICE_A);
        a.insert(0, "# Ship EOD report\n").unwrap();
        let seed = a.snapshot().unwrap();
        let mut b = YrsBody::from_snapshot(DEVICE_B, &seed).unwrap();
        assert_eq!(a.text(), b.text());

        // Now both go offline and edit the same body concurrently.
        a.insert(a.text().len() as u32, "- [ ] query event log\n")
            .unwrap();
        b.insert(b.text().len() as u32, "- [ ] carry-over logic\n")
            .unwrap();
        assert_ne!(a.text(), b.text(), "expected a genuine divergence to merge");

        sync(&mut a, &mut b);

        // Convergence: identical text on both replicas.
        assert_eq!(a.text(), b.text(), "replicas did not converge");

        // And no loss: every device's characters survived. This is the exact
        // failure per-field LWW would produce, and the reason the body gets a CRDT.
        let merged = a.text();
        assert!(merged.contains("# Ship EOD report"));
        assert!(merged.contains("- [ ] query event log"));
        assert!(merged.contains("- [ ] carry-over logic"));
    }

    #[test]
    fn concurrent_edits_converge_regardless_of_delivery_order() {
        // Commutativity: the relay fans out ops with no ordering guarantee across
        // devices, so A-then-B and B-then-A must land in the same place.
        let build = || {
            let mut seed_a = YrsBody::new(DEVICE_A);
            seed_a.insert(0, "base\n").unwrap();
            let seed = seed_a.snapshot().unwrap();
            let mut seed_b = YrsBody::from_snapshot(DEVICE_B, &seed).unwrap();
            seed_a.insert(5, "alpha\n").unwrap();
            seed_b.insert(5, "beta\n").unwrap();
            (seed_a, seed_b)
        };

        let (a1, b1) = build();
        let mut forward = YrsBody::new(99);
        forward.apply(&a1.snapshot().unwrap()).unwrap();
        forward.apply(&b1.snapshot().unwrap()).unwrap();

        let (a2, b2) = build();
        let mut backward = YrsBody::new(99);
        backward.apply(&b2.snapshot().unwrap()).unwrap();
        backward.apply(&a2.snapshot().unwrap()).unwrap();

        assert_eq!(
            forward.text(),
            backward.text(),
            "merge is not commutative — delivery order changed the result"
        );
    }

    #[test]
    fn applying_the_same_update_twice_is_a_no_op() {
        // The op log replays; a non-idempotent apply would duplicate text.
        let mut a = YrsBody::new(DEVICE_A);
        a.insert(0, "hello world").unwrap();
        let update = a.snapshot().unwrap();

        let mut b = YrsBody::new(DEVICE_B);
        b.apply(&update).unwrap();
        let once = b.text();
        b.apply(&update).unwrap();

        assert_eq!(once, b.text(), "re-applying an update changed the body");
        assert_eq!(b.text(), "hello world");
    }

    #[test]
    fn snapshot_round_trips_through_encode_decode() {
        let mut a = YrsBody::new(DEVICE_A);
        a.insert(0, "## Goal\nGrouped **markdown** export.\n")
            .unwrap();
        a.insert(8, "(revised) ").unwrap();
        let expected = a.text();

        // Encode → bytes → decode into a fresh replica.
        let snapshot = a.snapshot().unwrap();
        assert!(!snapshot.is_empty(), "snapshot encoded to zero bytes");
        let restored = YrsBody::from_snapshot(DEVICE_B, &snapshot).unwrap();

        assert_eq!(restored.text(), expected, "snapshot did not round-trip");
    }

    #[test]
    fn state_vector_round_trips_and_bounds_the_delta() {
        let mut a = YrsBody::new(DEVICE_A);
        a.insert(0, "shared prefix\n").unwrap();
        let mut b = YrsBody::from_snapshot(DEVICE_B, &a.snapshot().unwrap()).unwrap();

        // A state vector survives encode → decode: a delta computed against the
        // decoded vector equals one computed against the live replica.
        let sv = b.state_vector();
        let decoded = yrs::StateVector::decode_v1(sv.as_bytes()).expect("state vector decodes");
        assert_eq!(
            decoded.encode_v1(),
            sv.0,
            "state vector did not round-trip through encode/decode"
        );

        // Caught up: nothing to send.
        let empty_delta = a.diff(&sv).unwrap();

        // A now writes; the delta against B's vector carries only the new work,
        // and is strictly smaller than a full snapshot.
        a.insert(14, "only this is new\n").unwrap();
        let delta = a.diff(&b.state_vector()).unwrap();
        assert!(
            delta.len() > empty_delta.len(),
            "delta did not grow after an edit"
        );
        assert!(
            delta.len() < a.snapshot().unwrap().len(),
            "delta was not smaller than a full snapshot"
        );

        b.apply(&delta).unwrap();
        assert_eq!(a.text(), b.text());
    }

    #[test]
    fn concurrent_delete_and_insert_merge() {
        // Roadmap Phase 2 worked case, proven early: one device deletes a span
        // while the other inserts inside the same body.
        let mut a = YrsBody::new(DEVICE_A);
        a.insert(0, "keep DELETE keep").unwrap();
        let mut b = YrsBody::from_snapshot(DEVICE_B, &a.snapshot().unwrap()).unwrap();

        a.remove(5, 7).unwrap(); // drop "DELETE "
        b.insert(16, " and add").unwrap();

        sync(&mut a, &mut b);

        assert_eq!(a.text(), b.text(), "delete/insert did not converge");
        assert!(!a.text().contains("DELETE"), "delete was lost");
        assert!(a.text().contains("and add"), "concurrent insert was lost");
    }

    #[test]
    fn three_way_merge_converges() {
        // Desktop + phone + browser replica, all editing the same body offline.
        let mut a = YrsBody::new(1);
        a.insert(0, "root\n").unwrap();
        let seed = a.snapshot().unwrap();
        let mut b = YrsBody::from_snapshot(2, &seed).unwrap();
        let mut c = YrsBody::from_snapshot(3, &seed).unwrap();

        a.insert(5, "from-a\n").unwrap();
        b.insert(5, "from-b\n").unwrap();
        c.insert(5, "from-c\n").unwrap();

        sync(&mut a, &mut b);
        sync(&mut b, &mut c);
        sync(&mut a, &mut c);
        sync(&mut a, &mut b);

        assert_eq!(a.text(), b.text());
        assert_eq!(b.text(), c.text());
        for marker in ["root", "from-a", "from-b", "from-c"] {
            assert!(a.text().contains(marker), "lost {marker}");
        }
    }
}
