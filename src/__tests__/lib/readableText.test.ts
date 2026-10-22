import { describe, it, expect } from "vitest";
import { readableTextColor } from "@/lib/readableText";

describe("readableTextColor", () => {
  it("puts black text on light colours", () => {
    expect(readableTextColor("#FCFC10")).toBe("#000000"); // The Beats Run yellow
    expect(readableTextColor("#ffffff")).toBe("#000000");
    expect(readableTextColor("#C9A84C")).toBe("#000000"); // luxury template gold
  });

  it("keeps white text on dark colours", () => {
    expect(readableTextColor("#2563eb")).toBe("#ffffff"); // default blue
    expect(readableTextColor("#1a6b3c")).toBe("#ffffff");
    expect(readableTextColor("#000000")).toBe("#ffffff");
  });

  it("accepts short and upper-case hex", () => {
    expect(readableTextColor("#FF0")).toBe("#000000");
    expect(readableTextColor("#00f")).toBe("#ffffff");
  });

  it("falls back to white for anything that is not a hex colour", () => {
    expect(readableTextColor("")).toBe("#ffffff");
    expect(readableTextColor("yellow")).toBe("#ffffff");
    expect(readableTextColor("#12345")).toBe("#ffffff");
  });
});
