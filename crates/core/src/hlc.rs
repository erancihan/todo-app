//! Hybrid Logical Clock — the ordering authority for every non-body field.
//!
//! Per-field LWW resolves conflicts by HLC, not wall clock, so a laptop with a
//! skewed system time cannot silently win against a phone (docs/02-architecture.md
//! §4.1). An HLC is `(wall_ms, counter, device_id)` ordered lexicographically;
//! `counter` breaks ties inside the same millisecond, `device_id` breaks ties
//! between devices so the order is total and identical on every replica.

use std::cmp::Ordering;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::ids::DeviceId;

/// A single HLC stamp. Sorts by `(wall_ms, counter, device)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hlc {
    /// Milliseconds since the Unix epoch, UTC.
    pub wall_ms: u64,
    /// Monotonic tie-breaker within `wall_ms`.
    pub counter: u32,
    /// Originating replica — makes the total order deterministic across devices.
    pub device: DeviceId,
}

impl Hlc {
    pub fn new(wall_ms: u64, counter: u32, device: DeviceId) -> Self {
        Self {
            wall_ms,
            counter,
            device,
        }
    }

    /// True when `self` should overwrite `other` under per-field LWW.
    pub fn wins_over(&self, other: &Hlc) -> bool {
        self > other
    }
}

impl Ord for Hlc {
    fn cmp(&self, other: &Self) -> Ordering {
        self.wall_ms
            .cmp(&other.wall_ms)
            .then(self.counter.cmp(&other.counter))
            .then(self.device.as_str().cmp(other.device.as_str()))
    }
}

impl PartialOrd for Hlc {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Hlc {
    /// Sortable string form, as stored in `NODE.hlc` (docs/03-data-model.md §3.1).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:016x}-{:08x}-{}",
            self.wall_ms, self.counter, self.device
        )
    }
}

/// The per-replica clock. Every local mutation takes a stamp from [`HlcClock::now`];
/// every received op is fed through [`HlcClock::observe`] so this replica's clock
/// never falls behind causally.
#[derive(Debug, Clone)]
pub struct HlcClock {
    device: DeviceId,
    last_wall_ms: u64,
    counter: u32,
}

impl HlcClock {
    pub fn new(device: DeviceId) -> Self {
        Self {
            device,
            last_wall_ms: 0,
            counter: 0,
        }
    }

    /// Stamp a local event.
    pub fn now(&mut self) -> Hlc {
        let physical = wall_clock_ms();
        if physical > self.last_wall_ms {
            self.last_wall_ms = physical;
            self.counter = 0;
        } else {
            // Wall clock stalled or jumped backwards — keep moving logically.
            self.counter = self.counter.saturating_add(1);
        }
        Hlc::new(self.last_wall_ms, self.counter, self.device.clone())
    }

    /// Absorb a remote stamp, then issue one that is strictly greater. This is what
    /// makes the clock *causal*: after seeing a peer's op, our next stamp is later
    /// than it regardless of wall-clock skew between the two machines.
    pub fn observe(&mut self, remote: &Hlc) -> Hlc {
        let physical = wall_clock_ms();
        let max_wall = physical.max(self.last_wall_ms).max(remote.wall_ms);

        if max_wall == self.last_wall_ms && max_wall == remote.wall_ms {
            self.counter = self.counter.max(remote.counter).saturating_add(1);
        } else if max_wall == self.last_wall_ms {
            self.counter = self.counter.saturating_add(1);
        } else if max_wall == remote.wall_ms {
            self.counter = remote.counter.saturating_add(1);
        } else {
            self.counter = 0;
        }
        self.last_wall_ms = max_wall;
        Hlc::new(self.last_wall_ms, self.counter, self.device.clone())
    }

    pub fn device(&self) -> &DeviceId {
        &self.device
    }
}

/// Milliseconds since the Unix epoch.
///
/// `std::time::SystemTime` is unavailable on `wasm32-unknown-unknown`, so the
/// browser build reads the host clock through `js_sys::Date`.
#[cfg(not(target_arch = "wasm32"))]
fn wall_clock_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_arch = "wasm32")]
fn wall_clock_ms() -> u64 {
    js_sys::Date::now() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(name: &str) -> DeviceId {
        DeviceId::from(name)
    }

    #[test]
    fn stamps_from_one_clock_strictly_increase() {
        let mut clock = HlcClock::new(dev("a"));
        let mut previous = clock.now();
        for _ in 0..1_000 {
            let next = clock.now();
            assert!(next > previous, "{next} did not advance past {previous}");
            previous = next;
        }
    }

    #[test]
    fn observing_a_future_peer_pulls_our_clock_forward() {
        // Device B's system clock is an hour ahead. After A sees B's op, A's next
        // stamp must still beat it — otherwise A could never overwrite B's field.
        let mut a = HlcClock::new(dev("a"));
        let local = a.now();
        let from_the_future = Hlc::new(local.wall_ms + 3_600_000, 0, dev("b"));

        let after = a.observe(&from_the_future);
        assert!(
            after > from_the_future,
            "clock did not advance past a skewed peer"
        );
    }

    #[test]
    fn ties_break_deterministically_by_device() {
        // Same instant, same counter, different replicas: every replica must pick
        // the same winner or the projections diverge.
        let x = Hlc::new(100, 0, dev("aaa"));
        let y = Hlc::new(100, 0, dev("bbb"));
        assert!(y.wins_over(&x));
        assert!(!x.wins_over(&y));
    }

    #[test]
    fn display_form_sorts_lexicographically() {
        let earlier = Hlc::new(9, 0, dev("a"));
        let later = Hlc::new(10, 0, dev("a"));
        assert!(earlier < later);
        assert!(
            earlier.to_string() < later.to_string(),
            "zero-padded string form must sort like the struct"
        );
    }
}
