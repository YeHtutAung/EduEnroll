import { describe, it, expect } from "vitest";
import { lastEventDate, ticketExpiry } from "@/lib/tickets/exp";

describe("lastEventDate", () => {
  it("is the end date when the event runs past its start date", () => {
    expect(lastEventDate("2026-11-21", "2026-11-24")).toBe("2026-11-24");
  });
  it.each([
    ["the same as the start", "2026-11-21"],
    ["before the start", "2026-11-20"],
    ["missing", null],
    ["undefined", undefined],
  ])("is the start date when the end date is %s", (_label, end) => {
    expect(lastEventDate("2026-11-21", end)).toBe("2026-11-21");
  });
  it("stays null without a start date, so an undated ticket keeps its long expiry", () => {
    expect(lastEventDate(null, "2026-11-24")).toBeNull();
  });
});

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
