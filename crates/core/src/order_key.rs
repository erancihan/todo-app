//! Base62 fractional indexing for sibling order (docs/03-data-model.md §5.3).
//!
//! Inserting or moving a node writes **exactly one** key, placed strictly between
//! its two neighbours — no list-wide reindex, no server round-trip, and the key
//! merges as an ordinary LWW field.
//!
//! Two devices inserting into the same gap while offline would compute the *same*
//! fractional key, so every key carries a mandatory jitter suffix derived from the
//! device id.
//!
//! ```text
//! "a1-dev-a"  <  "a1V-dev-b"  <  "a2-dev-a"
//! ```
//!
//! # Deviation from docs/03-data-model.md §5.3
//!
//! The data model specifies the separator as `:` (`"a1:c7" < "a1V:c9" < "a2:c7"`).
//! **That separator is not sort-safe and is changed here to `-`.**
//!
//! Ordering is decided by SQLite's `ORDER BY order_key`, i.e. raw byte comparison,
//! so a bare key must always sort before any key that extends it. `:` is ASCII 58,
//! which sorts *above* the digits `0`-`9` (48-57) and only below `A`-`Z`/`a`-`z`.
//! The doc's worked example happens to extend with `V`, hiding the bug; extend with
//! a digit instead and the order inverts:
//!
//! ```text
//! "V:dev"  >  "V7:dev"     // ':' (58) > '7' (55) — WRONG, breaks list order
//! "V-dev"  <  "V7-dev"     // '-' (45) < '7' (55) — correct
//! ```
//!
//! `-` (ASCII 45) sorts below every base62 digit, so the invariant holds for all
//! 62 of them. Base62 itself is unchanged, and the doc's example keeps its stated
//! ordering under the new separator. Jitter suffixes are alphanumeric-only
//! ([`crate::ids::DeviceId::jitter_suffix`]), so `-` stays unambiguous as a split
//! point even though device ids contain dashes.
//!
//! Keys grow under repeated same-gap inserts; a background rebalance is scheduled
//! post-v1 (roadmap risk #10).

use crate::ids::DeviceId;

/// Base62 digits in ASCII-ascending order, so string comparison *is* numeric
/// comparison of the fraction.
const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: u32 = 62;

/// The character separating the fractional key from the device jitter suffix.
///
/// Must sort below every character in [`DIGITS`] — see the deviation note in this
/// module's docs for why this is `-` and not the `:` the data model specifies.
pub const JITTER_SEP: char = '-';

/// Strip the `:deviceId` suffix, leaving the comparable fractional part.
pub fn fraction_of(order_key: &str) -> &str {
    order_key.split(JITTER_SEP).next().unwrap_or(order_key)
}

/// Build a full `order_key` positioned strictly between `lower` and `upper`.
///
/// `None` means "no neighbour on that side" — `between(None, None, dev)` is the
/// key for the first item in an empty list.
pub fn between(lower: Option<&str>, upper: Option<&str>, device: &DeviceId) -> String {
    let fraction = fraction_between(lower.map(fraction_of), upper.map(fraction_of));
    format!("{fraction}{JITTER_SEP}{}", device.jitter_suffix())
}

/// The fractional part only, without a jitter suffix.
fn fraction_between(lower: Option<&str>, upper: Option<&str>) -> String {
    let lower = lower.unwrap_or("");
    match upper {
        // Unbounded above: walk `lower` until a digit has room, then split the
        // remaining span. Missing digits in `lower` read as 0.
        None => {
            let mut out = String::new();
            let mut i = 0;
            loop {
                let d = digit_at(lower, i).unwrap_or(0);
                if d + 1 < BASE {
                    out.push(digit_char((d + BASE) / 2));
                    return out;
                }
                out.push(digit_char(d));
                i += 1;
            }
        }
        Some(upper) => midpoint(lower, upper),
    }
}

/// A key strictly between `lower` and `upper`, both bounded. Requires
/// `lower < upper`; digits past the end of `lower` read as 0.
fn midpoint(lower: &str, upper: &str) -> String {
    debug_assert!(
        lower < upper || lower.is_empty(),
        "midpoint requires lower < upper, got {lower:?} / {upper:?}"
    );

    let mut out = String::new();
    let mut i = 0;

    // Copy the shared prefix.
    loop {
        let lo = digit_at(lower, i).unwrap_or(0);
        let hi = match digit_at(upper, i) {
            Some(d) => d,
            // `upper` ran out while still above `lower`: everything below is free.
            None => BASE,
        };

        if lo == hi {
            out.push(digit_char(lo));
            i += 1;
            continue;
        }

        // A gap exists at this position: take the midpoint if it is a real step up.
        let mid = (lo + hi) / 2;
        if mid > lo {
            out.push(digit_char(mid));
            return out;
        }

        // Neighbouring digits (e.g. 1 and 2) leave no room here — keep `lower`'s
        // digit and lengthen the key, now unbounded above.
        out.push(digit_char(lo));
        i += 1;
        loop {
            let d = digit_at(lower, i).unwrap_or(0);
            if d + 1 < BASE {
                out.push(digit_char((d + BASE) / 2));
                return out;
            }
            out.push(digit_char(d));
            i += 1;
        }
    }
}

fn digit_at(s: &str, i: usize) -> Option<u32> {
    s.as_bytes()
        .get(i)
        .and_then(|b| DIGITS.iter().position(|d| d == b))
        .map(|p| p as u32)
}

fn digit_char(d: u32) -> char {
    DIGITS[d as usize] as char
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(name: &str) -> DeviceId {
        DeviceId::from(name)
    }

    #[test]
    fn first_key_lands_mid_range_and_carries_a_suffix() {
        let key = between(None, None, &dev("device-a"));
        assert!(key.contains(JITTER_SEP), "jitter suffix is mandatory");
        assert!(!fraction_of(&key).is_empty());
    }

    #[test]
    fn insert_between_neighbours_sorts_strictly_between_them() {
        let d = dev("device-a");
        let first = between(None, None, &d);
        let last = between(Some(&first), None, &d);
        assert!(first < last);

        let middle = between(Some(&first), Some(&last), &d);
        assert!(first < middle, "{first} !< {middle}");
        assert!(middle < last, "{middle} !< {last}");
    }

    #[test]
    fn repeated_inserts_into_the_same_gap_stay_ordered() {
        // The adversarial case from the risk register: always insert just after
        // the head. Keys lengthen, but ordering must never break.
        let d = dev("device-a");
        let head = between(None, None, &d);
        let tail = between(Some(&head), None, &d);

        let mut upper = tail.clone();
        for n in 0..200 {
            let next = between(Some(&head), Some(&upper), &d);
            assert!(head < next, "iteration {n}: {head} !< {next}");
            assert!(next < upper, "iteration {n}: {next} !< {upper}");
            upper = next;
        }
    }

    #[test]
    fn appending_repeatedly_stays_ordered() {
        let d = dev("device-a");
        let mut keys = vec![between(None, None, &d)];
        for _ in 0..200 {
            let next = between(keys.last().map(String::as_str), None, &d);
            assert!(*keys.last().unwrap() < next);
            keys.push(next);
        }
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "append order did not match sort order");
    }

    #[test]
    fn separator_sorts_below_every_base62_digit() {
        // The invariant the whole scheme rests on. `:` — the separator the data
        // model specifies — fails this for '0'..'9', which is why it was changed.
        for &digit in DIGITS {
            assert!(
                (JITTER_SEP as u8) < digit,
                "separator {JITTER_SEP:?} does not sort below base62 digit {:?}",
                digit as char
            );
        }
    }

    #[test]
    fn concurrent_same_gap_inserts_do_not_collide() {
        // Two offline devices insert into the identical gap. The fractional part
        // is the same by construction; the jitter suffix is what saves us.
        // Real UUIDv7 ids, because that is where a prefix-derived suffix collides.
        let a = DeviceId::generate();
        let b = DeviceId::generate();
        assert_ne!(
            a.jitter_suffix(),
            b.jitter_suffix(),
            "jitter source collided"
        );
        let lower = between(None, None, &a);
        let upper = between(Some(&lower), None, &a);

        let from_a = between(Some(&lower), Some(&upper), &a);
        let from_b = between(Some(&lower), Some(&upper), &b);

        assert_eq!(
            fraction_of(&from_a),
            fraction_of(&from_b),
            "test is only meaningful when the fractional parts collide"
        );
        assert_ne!(from_a, from_b, "jitter suffix failed to break the tie");

        // Both still sort inside the gap, and their relative order is the same on
        // every replica because it is decided by the suffix bytes.
        for key in [&from_a, &from_b] {
            assert!(lower < *key && key < &upper);
        }
    }

    #[test]
    fn bare_key_sorts_before_any_key_extending_it() {
        // Exhaustive over the alphabet: a suffixed key must sort before the same
        // fraction extended by *any* digit. This is the case the `:` separator got
        // wrong for '0'..'9'.
        let d = dev("device-a");
        let base = between(None, None, &d);
        let fraction = fraction_of(&base).to_owned();

        for &digit in DIGITS {
            let extended = format!("{fraction}{}{}{}", digit as char, JITTER_SEP, "other");
            assert!(
                base < extended,
                "{base} !< {extended} — separator sorts above digit {:?}",
                digit as char
            );
        }
    }

    #[test]
    fn prepending_before_the_first_item_stays_ordered() {
        let d = dev("device-a");
        let mut first = between(None, None, &d);
        for n in 0..100 {
            let next = between(None, Some(&first), &d);
            assert!(next < first, "iteration {n}: {next} !< {first}");
            first = next;
        }
    }
}
