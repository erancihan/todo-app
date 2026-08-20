//! The op log — what actually travels between replicas
//! (docs/02-architecture.md §4.1).
//!
//! Every op is idempotent by id, so replaying the log any number of times yields
//! the same SQLite projection.
//!
//! **Phase 0 scope:** the op shapes and their merge rules, as types. The append /
//! order / apply engine lands in Phase 1, and the relay channel in Phase 2.

use serde::{Deserialize, Serialize};

use crate::hlc::Hlc;
use crate::ids::Id;

/// One entry in the op log. The `hlc` on each variant is what per-field LWW
/// compares; `body_update` carries opaque CRDT bytes instead and merges by the
/// sequence CRDT's own rules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Op {
    /// Idempotent by id — client-generated, so offline create needs no round-trip.
    NodeCreate {
        node_id: Id,
        fields: serde_json::Value,
        hlc: Hlc,
    },
    /// LWW register: highest HLC wins, per field independently.
    FieldSet {
        node_id: Id,
        field: String,
        value: serde_json::Value,
        hlc: Hlc,
    },
    /// Sequence CRDT: commutative and idempotent, merged by [`crate::body`].
    BodyUpdate {
        node_id: Id,
        #[serde(with = "base64_bytes")]
        update: Vec<u8>,
    },
    /// Tombstoned join, LWW per `(node, tag)` pair.
    TagSet {
        node_id: Id,
        tag_id: Id,
        present: bool,
        hlc: Hlc,
    },
    /// Tombstoned `NODE_COLLECTION` join, LWW per `(node, collection)` pair.
    CollectionSet {
        node_id: Id,
        collection_id: Id,
        present: bool,
        hlc: Hlc,
    },
    /// Sets `promoted = true` in place. `parent_id` is untouched — no row copy.
    Promote { node_id: Id, hlc: Hlc },
    /// Tombstone. A causally-later delete beats a concurrent update; GC only
    /// behind the causal watermark.
    NodeDelete { node_id: Id, hlc: Hlc },
}

/// CRDT updates are raw bytes but the op log is JSON on the wire, so they travel
/// base64-encoded. Shares the encoder with the projection's `body_state` column
/// ([`crate::b64`]) — two encoders would be two chances to corrupt a body.
mod base64_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&crate::b64::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        crate::b64::decode(&text)
            .map_err(|_| serde::de::Error::custom("invalid base64 in body update"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{new_id, DeviceId};

    #[test]
    fn body_update_bytes_survive_a_json_round_trip() {
        // The op log is JSON on the wire but CRDT updates are binary. Losing a
        // byte here would corrupt a body irrecoverably.
        let update: Vec<u8> = (0u8..=255).cycle().take(1_000).collect();
        let op = Op::BodyUpdate {
            node_id: new_id(),
            update: update.clone(),
        };

        let json = serde_json::to_string(&op).unwrap();
        let back: Op = serde_json::from_str(&json).unwrap();

        match back {
            Op::BodyUpdate { update: got, .. } => assert_eq!(got, update),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn base64_handles_every_trailing_length() {
        for len in 0..8 {
            let bytes: Vec<u8> = (0..len).map(|i| i as u8 * 37).collect();
            let op = Op::BodyUpdate {
                node_id: new_id(),
                update: bytes.clone(),
            };
            let back: Op = serde_json::from_str(&serde_json::to_string(&op).unwrap()).unwrap();
            match back {
                Op::BodyUpdate { update: got, .. } => assert_eq!(got, bytes, "len {len}"),
                other => panic!("wrong variant: {other:?}"),
            }
        }
    }

    #[test]
    fn ops_round_trip_as_tagged_json() {
        let op = Op::FieldSet {
            node_id: new_id(),
            field: "status".into(),
            value: serde_json::json!("done"),
            hlc: Hlc::new(1, 0, DeviceId::from("dev")),
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"kind\":\"field_set\""));
        assert_eq!(serde_json::from_str::<Op>(&json).unwrap(), op);
    }
}
