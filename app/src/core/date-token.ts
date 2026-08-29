/**
 * The `!` date grammar — natural-language scheduling in the capture line.
 *
 * Deliberately **bounded**: a small set of forms, each deterministic, parsed by
 * hand. A full NL date library would accept a thousand phrasings and guess at
 * the ambiguous ones; a capture tool must never guess about time, because a
 * wrong guess is silent and shows up as a missed day. Everything here parses to
 * exactly one civil day or does not parse at all.
 *
 * The clock is a parameter so every test pins its own "today" — date code that
 * reads the real clock inline is date code that fails twice a year.
 */

import { localDayKey } from "./list-controller";

export interface ParsedDay {
  /** The resolved civil day, `YYYY-MM-DD`. */
  day: string;
  /** A human preview for the completion menu — "Mon, Sep 1". */
  label: string;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

function preview(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function toParsed(d: Date): ParsedDay {
  return { day: localDayKey(d), label: preview(d) };
}

function addDays(now: Date, days: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d;
}

/** Index of a weekday name or 3-letter prefix, or -1. */
function weekdayIndex(word: string): number {
  if (word.length < 3) return -1;
  return WEEKDAYS.findIndex((w) => w === word || w.slice(0, 3) === word);
}

function monthIndex(word: string): number {
  if (word.length < 3) return -1;
  return MONTHS.findIndex((m) => m === word || m.slice(0, 3) === word);
}

/**
 * Parse one token of the grammar against `now`. Returns null for anything the
 * grammar does not cover — which the caller shows as "no suggestion", never as
 * a guess.
 *
 * Weekday rule, stated once: a bare weekday means the *coming* one, today
 * included — "friday" said on a Friday means today. `next <weekday>` excludes
 * today, so it always moves forward.
 */
export function parseDayToken(input: string, now: Date = new Date()): ParsedDay | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  if (text === "today" || text === "tod") return toParsed(now);
  if (text === "tomorrow" || text === "tmr" || text === "tom") return toParsed(addDays(now, 1));

  if (text === "next week") {
    // The Monday after today, however close that is.
    const days = ((8 - now.getDay()) % 7) || 7;
    return toParsed(addDays(now, days));
  }

  const nextWeekday = /^next ([a-z]+)$/.exec(text);
  if (nextWeekday) {
    const target = weekdayIndex(nextWeekday[1]!);
    if (target === -1) return null;
    const days = ((target - now.getDay() + 7) % 7) || 7;
    return toParsed(addDays(now, days));
  }

  const bareWeekday = weekdayIndex(text);
  if (bareWeekday !== -1) {
    const days = (bareWeekday - now.getDay() + 7) % 7;
    return toParsed(addDays(now, days));
  }

  const inN = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(text);
  if (inN) {
    const n = Number(inN[1]);
    return toParsed(addDays(now, inN[2]!.startsWith("week") ? n * 7 : n));
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    // new Date(2026, 1, 31) silently rolls into March; a rolled date means the
    // input named a day that does not exist.
    if (d.getMonth() !== Number(iso[2]) - 1) return null;
    return toParsed(d);
  }

  // "aug 30" / "30 aug" / "august 30", optionally with a year.
  const monthDay =
    /^([a-z]+) (\d{1,2})(?: (\d{4}))?$/.exec(text) ??
    /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(text);
  if (monthDay) {
    const [a, b, year] = [monthDay[1]!, monthDay[2]!, monthDay[3]];
    const month = monthIndex(/^\d/.test(a) ? b : a);
    const dayNum = Number(/^\d/.test(a) ? a : b);
    if (month === -1 || dayNum < 1 || dayNum > 31) return null;

    let d = new Date(year ? Number(year) : now.getFullYear(), month, dayNum);
    if (d.getMonth() !== month) return null;
    // No year given and the day already passed: the next one people mean is
    // next year's, not eight months ago.
    if (!year && localDayKey(d) < localDayKey(now)) {
      d = new Date(now.getFullYear() + 1, month, dayNum);
      if (d.getMonth() !== month) return null;
    }
    return toParsed(d);
  }

  return null;
}

/** The static suggestions the menu offers before anything is typed. */
export const DAY_SUGGESTIONS = [
  "today",
  "tomorrow",
  "next week",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "in 3 days",
  "in 2 weeks",
] as const;

// -- the `!every` repeat grammar --------------------------------------------
//
// A TypeScript mirror of `crates/core/src/repeat.rs` — the engine's parser is
// the authority (it validates again on `setRepeat`), this one exists so the
// completion menu can recognise a rule as it is typed and plan the first
// occurrence. Weekday numbering matches JS `getDay`, same as the Rust side.

export interface ParsedRepeat {
  /** Canonical rule text, exactly what the engine stores — "every monday". */
  rule: string;
  /** The first occurrence to plan: today, or the coming matching day. */
  firstDay: string;
  /** Menu preview for that first day — "Mon, Sep 1". */
  label: string;
}

const REPEAT_SYNONYMS: Record<string, string> = {
  daily: "days",
  weekly: "weeks",
  monthly: "months",
  yearly: "years",
  annually: "years",
};

const REPEAT_UNITS: Record<string, string> = {
  day: "days",
  days: "days",
  week: "weeks",
  weeks: "weeks",
  month: "months",
  months: "months",
  year: "years",
  years: "years",
};

const UNIT_SINGULAR: Record<string, string> = {
  days: "day",
  weeks: "week",
  months: "month",
  years: "year",
};

export function parseRepeatToken(input: string, now: Date = new Date()): ParsedRepeat | null {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);

  let kind: string | null = null;
  let n = 1;
  let weekday = -1;

  if (words.length === 1) {
    kind = REPEAT_SYNONYMS[words[0]!] ?? null;
  } else if (words[0] !== "every") {
    return null;
  } else if (words.length === 2) {
    const unit = words[1]!;
    if (unit === "weekday") {
      kind = "weekdays";
    } else if (REPEAT_UNITS[unit] && !unit.endsWith("s")) {
      kind = REPEAT_UNITS[unit]!;
    } else {
      weekday = weekdayIndex(unit);
      if (weekday !== -1) kind = "weekday";
    }
  } else if (words.length === 3) {
    const count = Number(words[1]);
    if (!Number.isInteger(count) || count < 1 || count > 999) return null;
    n = count;
    kind = REPEAT_UNITS[words[2]!] ?? null;
  }
  if (!kind) return null;

  let rule: string;
  let first: Date;
  if (kind === "weekday") {
    rule = `every ${WEEKDAYS[weekday]!}`;
    // The coming matching day, today included — same convention as the bare
    // weekday date token.
    first = addDays(now, (weekday - now.getDay() + 7) % 7);
  } else if (kind === "weekdays") {
    rule = "every weekday";
    first = new Date(now);
    while (first.getDay() === 0 || first.getDay() === 6) first = addDays(first, 1);
  } else {
    rule = n === 1 ? `every ${UNIT_SINGULAR[kind]!}` : `every ${n} ${kind}`;
    // Interval rules start now: the task exists, today is its first occurrence,
    // and completing it is what advances the chain.
    first = now;
  }

  return { rule, firstDay: localDayKey(first), label: preview(first) };
}

/** Repeat forms the menu offers alongside the plain days. */
export const REPEAT_SUGGESTIONS = [
  "every day",
  "every week",
  "every month",
  "every weekday",
] as const;
