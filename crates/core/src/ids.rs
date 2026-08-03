//! Client-generated identifiers.
//!
//! Every id is minted on-device so a node can be created with no server round-trip
//! and every op is idempotent by id (docs/03-data-model.md §5.2). UUIDv7 carries a
//! millisecond timestamp prefix, so ids also sort roughly by creation time.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A NODE / COLLECTION / TAG / EVENT identifier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Id(String);

impl Id {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for Id {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

impl From<String> for Id {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Mint a fresh UUIDv7.
pub fn new_id() -> Id {
    Id(uuid::Uuid::now_v7().to_string())
}

/// A replica identity — stable for the lifetime of an install. Used as the HLC
/// tie-breaker and as the `:clientId` jitter suffix on fractional order keys.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId(String);

impl DeviceId {
    pub fn generate() -> Self {
        Self(uuid::Uuid::now_v7().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// A short, stable suffix for order keys. Kept tiny because it is appended to
    /// every `order_key` in the store.
    ///
    /// Taken from the **end** of the id, deliberately. UUIDv7 leads with a
    /// millisecond timestamp, so two devices provisioned in the same era share a
    /// long prefix — a prefix-derived suffix would collide for exactly the devices
    /// most likely to be a user's own, defeating the tie-break it exists for. The
    /// trailing bytes are the random half.
    pub fn jitter_suffix(&self) -> String {
        let alnum: Vec<char> = self
            .0
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        alnum[alnum.len().saturating_sub(6)..].iter().collect()
    }
}

impl From<&str> for DeviceId {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

impl fmt::Display for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
    }

    #[test]
    fn ids_sort_roughly_by_creation_time() {
        // UUIDv7's timestamp prefix is what makes this hold; it is relied on for
        // debugging and coarse tie-breaking, not for correctness.
        let mut previous = new_id();
        for _ in 0..64 {
            let next = new_id();
            assert!(next >= previous, "{next} sorted before {previous}");
            previous = next;
        }
    }

    #[test]
    fn jitter_suffix_is_short_and_stable() {
        let device = DeviceId::generate();
        assert_eq!(device.jitter_suffix(), device.jitter_suffix());
        assert!(device.jitter_suffix().len() <= 6);
    }
}
