// The default event time zone when TICKET_TZ is unset. move_order_buyer
// (20261122130000_leaders_phone.sql) hard-codes the same zone; a database
// test keeps the two equal.
export const DEFAULT_TICKET_TZ = "Asia/Yangon";

// Returns the tz's UTC offset (in ms) at the instant `date`, computed via
// Intl.DateTimeFormat so it does not depend on the host system's own timezone.
function getOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - date.getTime();
}

// The date an event finishes. The end date lives in classes.end_time, a DATE
// since migration 031. An end on or before the start, or an end with no start,
// is ignored. Both are YYYY-MM-DD, so they compare as strings.
export function lastEventDate(eventDate: string | null, endDate: string | null | undefined): string | null {
  if (!eventDate) return null;
  return endDate && endDate > eventDate ? endDate : eventDate;
}

// Today as YYYY-MM-DD in the given IANA tz, not the server's UTC date.
export function todayInTz(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Returns Unix seconds for 23:59:59 on the given date in the given IANA tz.
export function ticketExpiry(eventDate: string | null, tz: string): number {
  if (!eventDate) return Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  // Build the local wall-clock end-of-day, then find its UTC instant for `tz`.
  const [y, m, d] = eventDate.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59);
  // offset(tz) at that date: difference between the tz's local time and UTC.
  const offsetMs = getOffsetMs(new Date(guess), tz);
  return Math.floor((guess - offsetMs) / 1000);
}

// Display only (plan 4 decision 5): the share cutoff, in Unix seconds. SQL's
// share_cutoff() decides; it hard-codes Asia/Yangon, so this uses the default
// zone and never TICKET_TZ.
export function shareCutoffAt(eventDate: string | null): number | null {
  if (!eventDate) return null;
  const [y, m, d] = eventDate.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const startOfDay = guess - getOffsetMs(new Date(guess), DEFAULT_TICKET_TZ);
  return Math.floor(startOfDay / 1000) - 24 * 3600;
}
