//! The bounded repeat grammar and its civil-date arithmetic.
//!
//! Same philosophy as the `!` date token: a small set of forms, each
//! deterministic, parsed by hand. RRULE can express "the last workday of every
//! other month" — and with that power comes a parser nobody audits and edge
//! cases nobody meant. Everything here advances to exactly one civil day.
//!
//! Semantics, stated once: a rule is a **fixed schedule anchored on the plan
//! day**, not a stopwatch from completion. Completing the occurrence planned
//! for Monday — early, on time, or late — plans the next one for the following
//! Monday. Occurrences that would land in the past are skipped rather than
//! spawned pre-slipped: finishing a daily task three days late owes you the
//! next one tomorrow, not three stale copies.

/// A parsed rule. Weekdays are 0 = Sunday … 6 = Saturday, matching JS `getDay`
/// so the TS mirror and this file can be compared line by line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Repeat {
    Days(u32),
    Weeks(u32),
    Months(u32),
    Years(u32),
    Weekday(u8),
    /// Monday through Friday.
    Weekdays,
}

const WEEKDAYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

/// Parse a rule, or `None` for anything outside the grammar.
///
/// Accepted: `every day|week|month|year`, `every N days|weeks|months|years`,
/// `every <weekday>` (full name or 3-letter prefix), `every weekday`, and the
/// one-word forms `daily`, `weekly`, `monthly`, `yearly`.
pub fn parse(rule: &str) -> Option<Repeat> {
    let text = rule.trim().to_lowercase();
    let words: Vec<&str> = text.split_whitespace().collect();

    match words.as_slice() {
        ["daily"] => Some(Repeat::Days(1)),
        ["weekly"] => Some(Repeat::Weeks(1)),
        ["monthly"] => Some(Repeat::Months(1)),
        ["yearly"] | ["annually"] => Some(Repeat::Years(1)),
        ["every", unit] => match *unit {
            "day" => Some(Repeat::Days(1)),
            "week" => Some(Repeat::Weeks(1)),
            "month" => Some(Repeat::Months(1)),
            "year" => Some(Repeat::Years(1)),
            "weekday" => Some(Repeat::Weekdays),
            word => weekday_index(word).map(Repeat::Weekday),
        },
        ["every", n, unit] => {
            let n: u32 = n.parse().ok().filter(|n| (1..=999).contains(n))?;
            match *unit {
                "day" | "days" => Some(Repeat::Days(n)),
                "week" | "weeks" => Some(Repeat::Weeks(n)),
                "month" | "months" => Some(Repeat::Months(n)),
                "year" | "years" => Some(Repeat::Years(n)),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The canonical stored text for a rule — what `parse` accepts, minus the
/// synonyms, so every device renders the same words for the same rule.
pub fn canonical(rule: Repeat) -> String {
    match rule {
        Repeat::Days(1) => "every day".into(),
        Repeat::Days(n) => format!("every {n} days"),
        Repeat::Weeks(1) => "every week".into(),
        Repeat::Weeks(n) => format!("every {n} weeks"),
        Repeat::Months(1) => "every month".into(),
        Repeat::Months(n) => format!("every {n} months"),
        Repeat::Years(1) => "every year".into(),
        Repeat::Years(n) => format!("every {n} years"),
        Repeat::Weekday(w) => format!("every {}", WEEKDAYS[w as usize % 7]),
        Repeat::Weekdays => "every weekday".into(),
    }
}

fn weekday_index(word: &str) -> Option<u8> {
    if word.len() < 3 {
        return None;
    }
    WEEKDAYS
        .iter()
        .position(|w| *w == word || &w[..3] == word)
        .map(|i| i as u8)
}

/// The next occurrence: the first day the rule generates from `anchor` that is
/// strictly after both `anchor` and `today`.
///
/// `anchor` is the completed occurrence's plan day and carries the phase — an
/// every-2-weeks rule anchored on the 5th stays on the 5th's fortnights however
/// late one occurrence was finished. Both arguments are civil `YYYY-MM-DD`.
pub fn next_after(rule: Repeat, anchor: &str, today: &str) -> Option<String> {
    let (ay, am, ad) = parse_day(anchor)?;
    let anchor_days = days_from_civil(ay, am, ad);
    let (ty, tm, td) = parse_day(today)?;
    let today_days = days_from_civil(ty, tm, td);
    let floor = anchor_days.max(today_days);

    match rule {
        Repeat::Days(n) | Repeat::Weeks(n) => {
            let step = i64::from(n)
                * if matches!(rule, Repeat::Weeks(_)) {
                    7
                } else {
                    1
                };
            // Smallest k ≥ 1 with anchor + k·step > floor.
            let k = ((floor - anchor_days).div_euclid(step) + 1).max(1);
            Some(format_day(civil_from_days(anchor_days + k * step)))
        }
        Repeat::Months(n) | Repeat::Years(n) => {
            let step = i64::from(n)
                * if matches!(rule, Repeat::Years(_)) {
                    12
                } else {
                    1
                };
            // Stepped from the anchor each time, so the clamp never sticks:
            // Jan 31 → Feb 28 → Mar 31, not Mar 28.
            for k in 1..=1200 {
                let candidate = add_months(ay, am, ad, k * step);
                if days_from_civil(candidate.0, candidate.1, candidate.2) > floor {
                    return Some(format_day(candidate));
                }
            }
            None
        }
        Repeat::Weekday(w) => {
            let start = floor + 1;
            let offset = (i64::from(w) - weekday_of(start)).rem_euclid(7);
            Some(format_day(civil_from_days(start + offset)))
        }
        Repeat::Weekdays => {
            let mut day = floor + 1;
            while matches!(weekday_of(day), 0 | 6) {
                day += 1;
            }
            Some(format_day(civil_from_days(day)))
        }
    }
}

// -- civil-date arithmetic (Howard Hinnant's algorithms) --------------------

fn parse_day(day: &str) -> Option<(i64, i64, i64)> {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i64 = day[..4].parse().ok()?;
    let m: i64 = day[5..7].parse().ok()?;
    let d: i64 = day[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || d < 1 || d > last_day_of_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

fn format_day((y, m, d): (i64, i64, i64)) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday.
fn weekday_of(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

fn is_leap(y: i64) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

fn last_day_of_month(y: i64, m: i64) -> i64 {
    match m {
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// `anchor + delta` months, day-of-month clamped into the target month.
fn add_months(y: i64, m: i64, d: i64, delta: i64) -> (i64, i64, i64) {
    let total = y * 12 + (m - 1) + delta;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) + 1;
    (year, month, d.min(last_day_of_month(year, month)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_whole_grammar() {
        assert_eq!(parse("every day"), Some(Repeat::Days(1)));
        assert_eq!(parse("daily"), Some(Repeat::Days(1)));
        assert_eq!(parse("every 3 days"), Some(Repeat::Days(3)));
        assert_eq!(parse("every week"), Some(Repeat::Weeks(1)));
        assert_eq!(parse("weekly"), Some(Repeat::Weeks(1)));
        assert_eq!(parse("every 2 weeks"), Some(Repeat::Weeks(2)));
        assert_eq!(parse("every month"), Some(Repeat::Months(1)));
        assert_eq!(parse("every 6 months"), Some(Repeat::Months(6)));
        assert_eq!(parse("every year"), Some(Repeat::Years(1)));
        assert_eq!(parse("annually"), Some(Repeat::Years(1)));
        assert_eq!(parse("every monday"), Some(Repeat::Weekday(1)));
        assert_eq!(parse("every fri"), Some(Repeat::Weekday(5)));
        assert_eq!(parse("every weekday"), Some(Repeat::Weekdays));
        assert_eq!(parse("  Every  Monday "), Some(Repeat::Weekday(1)));
    }

    #[test]
    fn rejects_everything_else() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("every"), None);
        assert_eq!(parse("every 0 days"), None);
        assert_eq!(parse("every -1 days"), None);
        assert_eq!(parse("every other day"), None);
        assert_eq!(parse("every 2 mondays"), None);
        assert_eq!(parse("sometimes"), None);
    }

    #[test]
    fn canonical_names_one_spelling_per_rule() {
        assert_eq!(canonical(parse("daily").unwrap()), "every day");
        assert_eq!(canonical(parse("every 2 weeks").unwrap()), "every 2 weeks");
        assert_eq!(canonical(parse("every MON").unwrap()), "every monday");
        assert_eq!(canonical(parse("annually").unwrap()), "every year");
    }

    // 2026-01-05 is a Monday.
    #[test]
    fn interval_rules_step_from_the_anchor() {
        let rule = parse("every week").unwrap();
        // Completed on time: the following Monday.
        assert_eq!(
            next_after(rule, "2026-01-05", "2026-01-05").unwrap(),
            "2026-01-12"
        );
        // Completed early: still the following Monday, not a day after today.
        assert_eq!(
            next_after(rule, "2026-01-05", "2026-01-03").unwrap(),
            "2026-01-12"
        );
        // Completed late (the 14th): the stale 12th is skipped, phase kept.
        assert_eq!(
            next_after(rule, "2026-01-05", "2026-01-14").unwrap(),
            "2026-01-19"
        );
    }

    #[test]
    fn every_n_days_counts_civil_days() {
        let rule = parse("every 3 days").unwrap();
        assert_eq!(
            next_after(rule, "2026-01-30", "2026-01-30").unwrap(),
            "2026-02-02"
        );
    }

    #[test]
    fn monthly_clamps_but_never_sticks() {
        let rule = parse("every month").unwrap();
        // Jan 31 → Feb 28 (2026 is not a leap year)…
        assert_eq!(
            next_after(rule, "2026-01-31", "2026-01-31").unwrap(),
            "2026-02-28"
        );
        // …but the anchor stays the 31st, so March recovers it.
        assert_eq!(
            next_after(rule, "2026-01-31", "2026-02-28").unwrap(),
            "2026-03-31"
        );
    }

    #[test]
    fn yearly_handles_leap_day() {
        let rule = parse("every year").unwrap();
        assert_eq!(
            next_after(rule, "2028-02-29", "2028-02-29").unwrap(),
            "2029-02-28"
        );
    }

    #[test]
    fn weekday_rules_find_the_coming_one() {
        let monday = parse("every monday").unwrap();
        assert_eq!(
            next_after(monday, "2026-01-05", "2026-01-05").unwrap(),
            "2026-01-12"
        );
        // Completed late on a Wednesday: next Monday, not the stale one.
        assert_eq!(
            next_after(monday, "2026-01-05", "2026-01-14").unwrap(),
            "2026-01-19"
        );
    }

    #[test]
    fn every_weekday_skips_the_weekend() {
        let rule = parse("every weekday").unwrap();
        // Friday the 9th → Monday the 12th.
        assert_eq!(
            next_after(rule, "2026-01-09", "2026-01-09").unwrap(),
            "2026-01-12"
        );
        // Thursday → Friday.
        assert_eq!(
            next_after(rule, "2026-01-08", "2026-01-08").unwrap(),
            "2026-01-09"
        );
    }

    #[test]
    fn bad_days_produce_nothing() {
        let rule = parse("every day").unwrap();
        assert_eq!(next_after(rule, "2026-02-31", "2026-01-05"), None);
        assert_eq!(next_after(rule, "not-a-day", "2026-01-05"), None);
    }
}
