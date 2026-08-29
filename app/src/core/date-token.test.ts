/**
 * The `!` date grammar, pinned form by form.
 *
 * Every test injects the same fixed clock — Wednesday, January 14th 2026 —
 * because a relative date only *means* anything against a known "today". A test
 * that read the real clock would assert different days depending on when CI ran.
 */

import { describe, expect, it } from "vitest";

import { DAY_SUGGESTIONS, parseDayToken } from "./date-token";

/** Wednesday. Chosen mid-week so "before" and "after" weekdays both exist. */
const NOW = new Date(2026, 0, 14, 10, 30);

function day(input: string): string | null {
  return parseDayToken(input, NOW)?.day ?? null;
}

describe("the ! date grammar", () => {
  it("resolves today and tomorrow, with their short forms", () => {
    expect(day("today")).toBe("2026-01-14");
    expect(day("tod")).toBe("2026-01-14");
    expect(day("tomorrow")).toBe("2026-01-15");
    expect(day("tmr")).toBe("2026-01-15");
    expect(day("tom")).toBe("2026-01-15");
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(day("Tomorrow")).toBe("2026-01-15");
    expect(day("  NEXT WEEK ")).toBe("2026-01-19");
  });

  it("takes next week to mean the coming Monday", () => {
    expect(day("next week")).toBe("2026-01-19");
  });

  it("resolves a bare weekday to the coming one, today included", () => {
    // Said on a Wednesday, "wednesday" means today — not a week out.
    expect(day("wednesday")).toBe("2026-01-14");
    expect(day("friday")).toBe("2026-01-16");
    expect(day("fri")).toBe("2026-01-16");
    expect(day("saturday")).toBe("2026-01-17");
    expect(day("sunday")).toBe("2026-01-18");
    expect(day("mon")).toBe("2026-01-19");
  });

  it("makes next <weekday> always move forward", () => {
    // "next wednesday" on a Wednesday is a week away, never today.
    expect(day("next wednesday")).toBe("2026-01-21");
    expect(day("next fri")).toBe("2026-01-16");
    expect(day("next monday")).toBe("2026-01-19");
  });

  it("counts in N days and in N weeks from today", () => {
    expect(day("in 1 day")).toBe("2026-01-15");
    expect(day("in 3 days")).toBe("2026-01-17");
    expect(day("in 10 days")).toBe("2026-01-24");
    expect(day("in 1 week")).toBe("2026-01-21");
    expect(day("in 2 weeks")).toBe("2026-01-28");
  });

  it("accepts an ISO date only when that day exists", () => {
    expect(day("2026-02-03")).toBe("2026-02-03");
    // new Date() would silently roll these into the next month; the grammar
    // must reject them instead of scheduling a day the user did not name.
    expect(day("2026-02-31")).toBeNull();
    expect(day("2026-13-01")).toBeNull();
    expect(day("2026-00-10")).toBeNull();
  });

  it("reads month-day in either order, with 3-letter month prefixes", () => {
    expect(day("aug 30")).toBe("2026-08-30");
    expect(day("30 aug")).toBe("2026-08-30");
    expect(day("august 30")).toBe("2026-08-30");
    expect(day("sep 1")).toBe("2026-09-01");
  });

  it("rolls a passed month-day into next year — unless a year was given", () => {
    // January 2nd is behind a January 14th "now"; the next one is next year's.
    expect(day("jan 2")).toBe("2027-01-02");
    // Today itself has not passed.
    expect(day("jan 14")).toBe("2026-01-14");
    // An explicit year is taken literally, even in the past.
    expect(day("august 30 2025")).toBe("2025-08-30");
  });

  it("rejects month-days that do not exist", () => {
    expect(day("feb 30")).toBeNull();
    expect(day("feb 29")).toBeNull(); // 2026 is not a leap year
    expect(day("notamonth 5")).toBeNull();
    expect(day("aug 0")).toBeNull();
    expect(day("aug 32")).toBeNull();
  });

  it("parses nothing outside the grammar — no guessing", () => {
    expect(day("")).toBeNull();
    expect(day("someday")).toBeNull();
    expect(day("yesterday")).toBeNull(); // capture schedules forward only
    expect(day("next")).toBeNull();
    expect(day("in days")).toBeNull();
    expect(day("do the thing tomorrow")).toBeNull();
  });

  it("labels every result with a human date", () => {
    const parsed = parseDayToken("today", NOW);
    expect(parsed?.label).toContain("14");
  });

  it("can parse every one of its own menu suggestions", () => {
    for (const suggestion of DAY_SUGGESTIONS) {
      expect(parseDayToken(suggestion, NOW), suggestion).not.toBeNull();
    }
  });
});
