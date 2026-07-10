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

// Returns Unix seconds for 23:59:59 on event_date in the given IANA tz.
export function ticketExpiry(eventDate: string | null, tz: string): number {
  if (!eventDate) return Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  // Build the local wall-clock end-of-day, then find its UTC instant for `tz`.
  const [y, m, d] = eventDate.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59);
  // offset(tz) at that date: difference between the tz's local time and UTC.
  const offsetMs = getOffsetMs(new Date(guess), tz);
  return Math.floor((guess - offsetMs) / 1000);
}
