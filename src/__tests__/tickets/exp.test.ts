import { describe, it, expect } from "vitest";
import { ticketExpiry } from "@/lib/tickets/exp";

describe("ticketExpiry", () => {
  it("returns end-of-event-day epoch seconds in the event tz", () => {
    // 2026-07-12 23:59:59 Asia/Yangon (UTC+6:30) = 2026-07-12T17:29:59Z
    const exp = ticketExpiry("2026-07-12", "Asia/Yangon");
    expect(exp).toBe(Math.floor(Date.parse("2026-07-12T17:29:59+00:00") / 1000));
  });
  it("falls back to ~1 year out when event_date is null", () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = ticketExpiry(null, "Asia/Yangon");
    expect(exp).toBeGreaterThan(now + 300 * 24 * 3600);
  });
});
