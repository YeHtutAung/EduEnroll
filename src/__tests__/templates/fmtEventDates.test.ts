import { describe, expect, it } from "vitest";
import { fmtEventDates } from "@/components/enrollment/templates/types";

const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

describe("fmtEventDates", () => {
  it("shows both dates when the event ends on a later date", () => {
    expect(fmtEventDates("2026-11-21", "2026-11-24", opts)).toBe("21 Nov 2026 – 24 Nov 2026");
  });

  it("shows one date when the event starts and ends on the same date", () => {
    expect(fmtEventDates("2026-11-21", "2026-11-21", opts)).toBe("21 Nov 2026");
  });

  it.each([null, undefined, ""])("shows one date when the end date is %s", (end) => {
    expect(fmtEventDates("2026-11-21", end, opts)).toBe("21 Nov 2026");
  });

  it("never prints a backwards range for a mistyped end date", () => {
    expect(fmtEventDates("2026-11-21", "2026-11-20", opts)).toBe("21 Nov 2026");
  });

  it("orders dates across a month and year boundary", () => {
    expect(fmtEventDates("2026-12-31", "2027-01-02", opts)).toBe("31 Dec 2026 – 2 Jan 2027");
  });

  it("uses the format each template asks for", () => {
    expect(fmtEventDates("2026-11-21", "2026-11-24", { day: "numeric", month: "long", year: "numeric" })).toBe(
      "21 November 2026 – 24 November 2026",
    );
  });
});
