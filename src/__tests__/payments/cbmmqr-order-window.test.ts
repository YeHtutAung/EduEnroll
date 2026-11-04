import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cbQrMinutes, CB_EXPIRY_MARGIN_MINUTES, enrollmentDeadline, preCheck, postCheck, provisionalExpiry,
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
  const need = (cbQrMinutes() + CB_EXPIRY_MARGIN_MINUTES) * MIN;
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

// CB, 2026-11-04: a QR lives 20 minutes in UAT and 5 in Production.
describe("cbQrMinutes", () => {
  afterEach(() => {
    delete process.env.CBMMQR_MODE;
    delete process.env.VERCEL_ENV;
  });

  it("is 20 with no mode, as UAT", () => expect(cbQrMinutes()).toBe(20));

  it("is 20 in UAT", () => {
    process.env.CBMMQR_MODE = "uat";
    expect(cbQrMinutes()).toBe(20);
  });

  it("is 5 in Production", () => {
    process.env.CBMMQR_MODE = "production";
    expect(cbQrMinutes()).toBe(5);
  });

  it("throws on an unrecognised mode rather than guessing", () => {
    process.env.CBMMQR_MODE = "prod";
    expect(() => cbQrMinutes()).toThrow(/CBMMQR_MODE/);
  });

  it("throws on a production deployment that is not in production mode", () => {
    process.env.VERCEL_ENV = "production";
    expect(() => cbQrMinutes()).toThrow(/CBMMQR_MODE/);
  });
});

describe("a 5-minute Production QR against a booking window", () => {
  const enrolled = "2026-11-03T11:36:54Z";
  const at = Date.parse(enrolled);
  const qrExpiry = (now: number) => now + 5 * MIN;

  beforeEach(() => { process.env.CBMMQR_MODE = "production"; });
  afterEach(() => { delete process.env.CBMMQR_MODE; });

  it("a 15-minute booking can show one for the first 8 minutes", () => {
    const deadline = enrollmentDeadline(15, enrolled);
    const early = at + 7 * MIN;
    expect(preCheck(deadline, early)).toBe("ok");
    expect(postCheck(deadline, qrExpiry(early))).toBe("ok");
    expect(preCheck(deadline, at + 8 * MIN + 1000)).toBe("too_close");
  });

  it("a 30-minute booking can show one for the first 23 minutes", () => {
    const deadline = enrollmentDeadline(30, enrolled);
    expect(preCheck(deadline, at + 22 * MIN)).toBe("ok");
    expect(preCheck(deadline, at + 23 * MIN + 1000)).toBe("too_close");
  });

  it("holds a provisional expiry of 7 minutes", () => {
    expect(provisionalExpiry(at)).toBe(at + 7 * MIN);
  });

  it("still refuses a QR that outlives the booking, if CB ever issues a longer one", () => {
    const deadline = enrollmentDeadline(15, enrolled);
    expect(postCheck(deadline, at + 20 * MIN)).toBe("too_late");
  });
});

describe("a 20-minute UAT QR against a booking window", () => {
  const enrolled = "2026-11-03T11:36:54Z";
  const at = Date.parse(enrolled);
  const qrExpiry = (now: number) => now + 20 * MIN;

  it("a 15-minute booking can never show one", () => {
    const deadline = enrollmentDeadline(15, enrolled);
    expect(preCheck(deadline, at)).toBe("too_close");
    expect(postCheck(deadline, qrExpiry(at))).toBe("too_late");
  });

  it("a 30-minute booking can, for the first 8 minutes", () => {
    const deadline = enrollmentDeadline(30, enrolled);
    const early = at + 7 * MIN;
    expect(preCheck(deadline, early)).toBe("ok");
    expect(postCheck(deadline, qrExpiry(early))).toBe("ok");
    expect(preCheck(deadline, at + 8 * MIN + 1000)).toBe("too_close");
  });
});

describe("provisionalExpiry", () => {
  it("is now + max validity + margin", () =>
    expect(provisionalExpiry(now)).toBe(now + (cbQrMinutes() + CB_EXPIRY_MARGIN_MINUTES) * MIN));
});
