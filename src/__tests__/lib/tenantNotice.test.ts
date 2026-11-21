import { describe, it, expect } from "vitest";
import { WALK_IN_NOTICE_ENDS_AT, walkInNoticeApplies } from "@/lib/tenantNotice";

const DURING = Date.parse("2026-11-21T06:00:00Z");

describe("walkInNoticeApplies", () => {
  it("shows on Sky Festival's public pages during the festival", () => {
    for (const path of ["/enroll", "/enroll/sky-2026", "/enroll/sky-2026/tickets", "/enroll/form"]) {
      expect(walkInNoticeApplies("skyfestival", path, DURING)).toBe(true);
    }
  });

  it("never shows for another tenant or with no tenant", () => {
    expect(walkInNoticeApplies("beatsrun", "/enroll", DURING)).toBe(false);
    expect(walkInNoticeApplies(null, "/enroll", DURING)).toBe(false);
  });

  it("never covers an order or ticket page", () => {
    expect(walkInNoticeApplies("skyfestival", "/enroll/payment/SF2-1105-AAAAAA", DURING)).toBe(false);
    expect(walkInNoticeApplies("skyfestival", "/status", DURING)).toBe(false);
  });

  it("does not treat a lookalike path as excluded", () => {
    expect(walkInNoticeApplies("skyfestival", "/enroll/payments-info", DURING)).toBe(true);
  });

  it("stops at the end of 24 Nov in Yangon", () => {
    expect(walkInNoticeApplies("skyfestival", "/enroll", WALK_IN_NOTICE_ENDS_AT - 1)).toBe(true);
    expect(walkInNoticeApplies("skyfestival", "/enroll", WALK_IN_NOTICE_ENDS_AT)).toBe(false);
    expect(new Date(WALK_IN_NOTICE_ENDS_AT).toISOString()).toBe("2026-11-24T17:30:00.000Z");
  });
});
