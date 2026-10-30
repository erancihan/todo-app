/**
 * Civil-day helpers — the local calendar, not UTC.
 *
 * Pulled out of the controller so the modules that need a day key (the
 * controller, the `!` grammar, the view) depend on this leaf rather than on
 * each other. Everything here is about *the viewer's* calendar, which is the
 * one thing the engine deliberately does not know.
 */

/**
 * `YYYY-MM-DD` for a Date in the *local* timezone.
 *
 * Not `toISOString().slice(0, 10)`: that converts to UTC first, so anyone east
 * of Greenwich in the evening — or west of it in the morning — would get
 * yesterday's or tomorrow's report without being told.
 */
export function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local midnight a `YYYY-MM-DD` names. */
export function dayKeyToDate(day: string): Date {
  return new Date(`${day}T00:00:00`);
}

/** The last millisecond of a local `YYYY-MM-DD`. */
export function endOfLocalDay(day: string): number {
  const date = dayKeyToDate(day);
  date.setDate(date.getDate() + 1);
  return date.getTime() - 1;
}

/** A due timestamp back to the `YYYY-MM-DD` an `<input type="date">` wants. */
export function dueDayValue(ms: number | null): string {
  return ms ? localDayKey(new Date(ms)) : "";
}

/** The next Monday strictly after today — the "next week" everyone means. */
export function nextMondayKey(): string {
  const d = new Date();
  const days = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + days);
  return localDayKey(d);
}

/** Start of the local today, in ms. */
export function startOfTodayMs(): number {
  return dayKeyToDate(localDayKey(new Date())).getTime();
}

/** A short human date — "Mon, Sep 1" — for menus and toasts. */
export function formatDay(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** `formatDay` for a `YYYY-MM-DD`. */
export function formatDayKey(day: string): string {
  return formatDay(dayKeyToDate(day));
}
