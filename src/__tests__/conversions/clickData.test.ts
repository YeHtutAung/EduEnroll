import { describe, it, expect } from "vitest";
import {
  AD_CLICK_COOKIE,
  cleanClickValue,
  nextClickCookie,
  parseClickCookie,
  buildFbc,
  forwardedClickQuery,
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

describe("capture time", () => {
  const t0 = 1_700_000_000_000;
  it("does not move the fbclid time when only a ttclid lands", () => {
    const existing = nextClickCookie("?fbclid=F1", null, t0);
    expect(parseClickCookie(nextClickCookie("?ttclid=T1", existing, t0 + 5))).toEqual({ fbclid: "F1", ttclid: "T1", at: t0 });
  });
  it("does not move the time on a reload of the same fbclid", () => {
    const existing = nextClickCookie("?fbclid=F1", null, t0);
    expect(parseClickCookie(nextClickCookie("?fbclid=F1", existing, t0 + 9)).at).toBe(t0);
  });
  it("moves the time when the fbclid changes", () => {
    const existing = nextClickCookie("?fbclid=F1", null, t0);
    expect(parseClickCookie(nextClickCookie("?fbclid=F2", existing, t0 + 9))).toMatchObject({ fbclid: "F2", at: t0 + 9 });
  });
});

describe("parseClickCookie timestamps and encoding", () => {
  const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o));
  it("rejects a non-positive, fractional or unsafe time", () => {
    for (const at of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2, "5", null]) {
      expect(parseClickCookie(enc({ fbclid: "F1", ttclid: null, at })).at, String(at)).toBeNull();
    }
  });
  it("accepts a plain JSON value, as Next's cookie parser hands over", () => {
    expect(parseClickCookie(JSON.stringify({ fbclid: "F1", ttclid: "T1", at: 7 }))).toEqual({ fbclid: "F1", ttclid: "T1", at: 7 });
  });
});

describe("forwardedClickQuery", () => {
  it("forwards only fbclid and ttclid", () => {
    expect(forwardedClickQuery(new URLSearchParams("fbclid=F1&ttclid=T1&ref=X&utm_source=a"))).toBe("?fbclid=F1&ttclid=T1");
  });
  it("forwards one ID alone", () => expect(forwardedClickQuery(new URLSearchParams("ttclid=T1"))).toBe("?ttclid=T1"));
  it("drops invalid values", () => {
    expect(forwardedClickQuery(new URLSearchParams("fbclid=%3Cx%3E&ttclid=T1"))).toBe("?ttclid=T1");
  });
  it("returns an empty string when there is nothing to forward", () => {
    expect(forwardedClickQuery(new URLSearchParams("ref=X"))).toBe("");
    expect(forwardedClickQuery(new URLSearchParams(""))).toBe("");
  });
  it("encodes what it forwards", () => {
    expect(forwardedClickQuery(new URLSearchParams("fbclid=a%2Bb/c=d"))).toBe("?fbclid=a%2Bb%2Fc%3Dd");
  });
});
