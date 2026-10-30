import { describe, it, expect } from "vitest";
import {
  CB_MAX_QR_MINUTES, CB_EXPIRY_MARGIN_MINUTES, enrollmentDeadline, preCheck, postCheck, provisionalExpiry,
} from "@/server/payments/cbmmqrOrderWindow";

const MIN = 60_000;
const now = Date.parse("2026-10-31T04:00:00Z");
const enrolled = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();

describe("enrollmentDeadline", () => {
  it("none when auto-cancel is off (0 or null)", () => {
    expect(enrollmentDeadline(0, enrolled(1))).toEqual({ kind: "none" });
    expect(enrollmentDeadline(null, enrolled(1))).toEqual({ kind: "none" });
  });
  it("enrolled_at + auto_cancel_hours MINUTES (the column holds minutes, migration 058)", () => {
    expect(enrollmentDeadline(15, enrolled(5))).toEqual({ kind: "at", ms: now + 10 * MIN });
  });
  it("unknown when enrolled_at cannot be read", () => {
    expect(enrollmentDeadline(15, null)).toEqual({ kind: "unknown" });
    expect(enrollmentDeadline(15, "garbage")).toEqual({ kind: "unknown" });
  });
});

describe("preCheck", () => {
  const need = (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN;
  it("ok with no deadline", () => expect(preCheck({ kind: "none" }, now)).toBe("ok"));
  it("unknown stays unknown", () => expect(preCheck({ kind: "unknown" }, now)).toBe("unknown"));
  it("ok exactly at max validity + margin", () => expect(preCheck({ kind: "at", ms: now + need }, now)).toBe("ok"));
  it("too_close one second inside it", () => expect(preCheck({ kind: "at", ms: now + need - 1000 }, now)).toBe("too_close"));
});

describe("postCheck", () => {
  const deadline = { kind: "at" as const, ms: now + 10 * MIN };
  const margin = CB_EXPIRY_MARGIN_MINUTES * MIN;
  it("ok when CB's expiry is before the deadline minus the margin", () =>
    expect(postCheck(deadline, deadline.ms - margin - 1)).toBe("ok"));
  it("too_late at deadline minus margin", () => expect(postCheck(deadline, deadline.ms - margin)).toBe("too_late"));
  it("too_late when CB's expiry is unreadable", () => expect(postCheck(deadline, null)).toBe("too_late"));
  it("too_late when the deadline is unknown", () => expect(postCheck({ kind: "unknown" }, now)).toBe("too_late"));
  it("ok with no deadline and a readable expiry", () => expect(postCheck({ kind: "none" }, now + MIN)).toBe("ok"));
  it("too_late with no deadline but an unreadable expiry", () => expect(postCheck({ kind: "none" }, null)).toBe("too_late"));
});

describe("provisionalExpiry", () => {
  it("is now + max validity + margin", () =>
    expect(provisionalExpiry(now)).toBe(now + (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN));
});
