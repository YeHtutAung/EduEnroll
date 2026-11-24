import { describe, it, expect } from "vitest";
import { shareCutoffAt } from "@/lib/tickets/exp";

describe("shareCutoffAt", () => {
  it("is the start of the event day in Yangon minus 24 hours", () => {
    expect(shareCutoffAt("2026-12-05")).toBe(Date.parse("2026-12-03T17:30:00Z") / 1000);
  });
  it("is null without a date", () => {
    expect(shareCutoffAt(null)).toBeNull();
  });
});
