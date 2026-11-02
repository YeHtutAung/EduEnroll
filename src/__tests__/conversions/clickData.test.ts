import { describe, it, expect } from "vitest";
import {
  AD_CLICK_COOKIE,
  cleanClickValue,
  nextClickCookie,
  parseClickCookie,
  buildFbc,
} from "@/lib/conversions/clickData";

describe("cleanClickValue", () => {
  it("accepts a normal value", () => expect(cleanClickValue("fb.1.1700000000.abc-DEF_1")).toBe("fb.1.1700000000.abc-DEF_1"));
  it("drops script characters", () => expect(cleanClickValue("<script>")).toBeNull());
  it("drops an over-long value", () => expect(cleanClickValue("a".repeat(501))).toBeNull());
  it("drops empty and missing values", () => {
    expect(cleanClickValue("")).toBeNull();
    expect(cleanClickValue(undefined)).toBeNull();
  });
});

describe("nextClickCookie", () => {
  const now = 1_700_000_000_000;

  it("returns null when the URL has no click ID", () => {
    expect(nextClickCookie("?utm_source=fb", null, now)).toBeNull();
  });
  it("stores a new fbclid with its capture time", () => {
    expect(parseClickCookie(nextClickCookie("?fbclid=AB1", null, now))).toEqual({ fbclid: "AB1", ttclid: null, at: now });
  });
  it("keeps the other platform's ID when only one changes", () => {
    const existing = nextClickCookie("?ttclid=T1", null, now);
    expect(parseClickCookie(nextClickCookie("?fbclid=F1", existing, now + 1))).toEqual({ fbclid: "F1", ttclid: "T1", at: now + 1 });
  });
  it("ignores an invalid ID", () => {
    expect(nextClickCookie("?fbclid=%3Cx%3E", null, now)).toBeNull();
  });
});

describe("parseClickCookie", () => {
  it("returns empty for a missing or malformed cookie", () => {
    const empty = { fbclid: null, ttclid: null, at: null };
    expect(parseClickCookie(undefined)).toEqual(empty);
    expect(parseClickCookie("not json")).toEqual(empty);
  });
  it("re-validates values on the way in", () => {
    const raw = encodeURIComponent(JSON.stringify({ fbclid: "<x>", ttclid: "T1", at: 5 }));
    expect(parseClickCookie(raw)).toEqual({ fbclid: null, ttclid: "T1", at: 5 });
  });
});

describe("buildFbc", () => {
  it("uses Meta's format", () => expect(buildFbc("AB1", 1700)).toBe("fb.1.1700.AB1"));
});

it("has a stable cookie name", () => expect(AD_CLICK_COOKIE).toBe("kn_ad_click"));
