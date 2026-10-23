import { describe, it, expect } from "vitest";
import {
  eventFontCssUrl,
  eventFontStack,
  eventFontStyle,
  validateEventFont,
} from "@/lib/eventFont";

const URL = "https://use.typekit.net/abc1234.css";

describe("validateEventFont", () => {
  it("accepts an Adobe Fonts link with a font name", () => {
    expect(validateEventFont(URL, "antique-olive-nord")).toEqual({
      ok: true,
      value: { font_css_url: URL, font_family: "antique-olive-nord" },
    });
  });

  it("treats blank or null in both as clearing the font", () => {
    const cleared = { ok: true, value: { font_css_url: null, font_family: null } };
    expect(validateEventFont("", " ")).toEqual(cleared);
    expect(validateEventFont(null, null)).toEqual(cleared);
  });

  it("requires both or neither", () => {
    expect(validateEventFont(URL, "").ok).toBe(false);
    expect(validateEventFont("", "antique-olive-nord").ok).toBe(false);
  });

  it("only accepts use.typekit.net stylesheets over https", () => {
    for (const bad of [
      "http://use.typekit.net/abc1234.css",
      "https://use.typekit.net.evil.com/abc1234.css",
      "https://fonts.example.com/abc1234.css",
      "https://use.typekit.net/abc1234.js",
      "https://use.typekit.net/../x.css",
    ]) {
      expect(validateEventFont(bad, "antique-olive-nord").ok).toBe(false);
    }
  });

  it("refuses font names that could break out of an inline style", () => {
    for (const bad of ["x'; color: red", "a}b", "x\"y", "-leading-hyphen", "a".repeat(65)]) {
      expect(validateEventFont(URL, bad).ok).toBe(false);
    }
  });

  it("rejects non-string values", () => {
    expect(validateEventFont(42, "x").ok).toBe(false);
  });
});

describe("eventFontStack / eventFontCssUrl / eventFontStyle", () => {
  it("puts the event's font before the fallback", () => {
    expect(eventFontStack("antique-olive-nord", "'Bebas Neue', sans-serif")).toBe(
      "'antique-olive-nord', 'Bebas Neue', sans-serif",
    );
  });

  it("returns the fallback alone with no or an invalid family", () => {
    expect(eventFontStack(null, "serif")).toBe("serif");
    expect(eventFontStack("x'; y", "serif")).toBe("serif");
  });

  it("only passes through a valid stylesheet link", () => {
    expect(eventFontCssUrl(URL)).toBe(URL);
    expect(eventFontCssUrl("https://evil.example/x.css")).toBeNull();
    expect(eventFontCssUrl(null)).toBeNull();
  });

  it("styles a root only when the event has a full, valid font", () => {
    expect(eventFontStyle({ font_css_url: URL, font_family: "antique-olive-nord" }).fontFamily).toMatch(
      /^'antique-olive-nord', var\(--font-noto-sans\)/,
    );
    expect(eventFontStyle({ font_css_url: null, font_family: "antique-olive-nord" })).toEqual({});
    expect(eventFontStyle({})).toEqual({});
  });
});
