import { describe, it, expect } from "vitest";
import {
  WALK_IN_NOTICE_COOKIE,
  WALK_IN_NOTICE_ENDS_AT,
  walkInNoticeApplies,
  walkInNoticeSeen,
} from "@/lib/tenantNotice";
import { SAFE_STORAGE_KEYS } from "@/lib/tagManager";

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

describe("walkInNoticeSeen", () => {
  it("reads its own cookie only", () => {
    expect(walkInNoticeSeen("")).toBe(false);
    expect(walkInNoticeSeen(`_fbp=fb.1.2; ${WALK_IN_NOTICE_COOKIE}=1`)).toBe(true);
    expect(walkInNoticeSeen(`x${WALK_IN_NOTICE_COOKIE}=1`)).toBe(false);
  });

  it("uses a cookie name GTM's gate does not block on", () => {
    // GTM turns off for any sb- cookie; storage keys are allowlisted separately.
    expect(WALK_IN_NOTICE_COOKIE.startsWith("sb-")).toBe(false);
    expect(SAFE_STORAGE_KEYS.length).toBeGreaterThan(0);
  });
});
