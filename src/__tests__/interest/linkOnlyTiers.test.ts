import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hideLinkOnlyTiers, isLinkOnlyTier } from "@/lib/interest/priorityUnlock";

// A tier that closes before it opens has no public sale at all: only priority
// link holders can ever buy it. BeatsRun's Pre-registration is set up this way,
// and the public page was promising it with "Opens 10 Nov".

const OPEN = "2026-11-09T17:30:00+00:00";
const ONE_MINUTE_EARLIER = "2026-11-09T17:29:00+00:00";
const LATER = "2026-11-30T17:30:00+00:00";

describe("isLinkOnlyTier", () => {
  it("is true when the tier closes before it opens", () => {
    expect(isLinkOnlyTier({ enrollment_open_at: OPEN, enrollment_close_at: ONE_MINUTE_EARLIER })).toBe(true);
  });

  it("is true when the tier closes the moment it opens", () => {
    expect(isLinkOnlyTier({ enrollment_open_at: OPEN, enrollment_close_at: OPEN })).toBe(true);
  });

  it("is false for a tier with a public sale, even one that has not started", () => {
    expect(isLinkOnlyTier({ enrollment_open_at: OPEN, enrollment_close_at: LATER })).toBe(false);
  });

  it("is false when either date is missing", () => {
    expect(isLinkOnlyTier({ enrollment_open_at: null, enrollment_close_at: OPEN })).toBe(false);
    expect(isLinkOnlyTier({ enrollment_open_at: OPEN, enrollment_close_at: null })).toBe(false);
    expect(isLinkOnlyTier({})).toBe(false);
  });

  it("is false on an unparseable date, so a bad value never hides a tier", () => {
    expect(isLinkOnlyTier({ enrollment_open_at: "not a date", enrollment_close_at: OPEN })).toBe(false);
    expect(isLinkOnlyTier({ enrollment_open_at: OPEN, enrollment_close_at: "not a date" })).toBe(false);
  });
});

describe("hideLinkOnlyTiers", () => {
  const linkOnly = { id: "link-only", enrollment_open_at: OPEN, enrollment_close_at: ONE_MINUTE_EARLIER };
  const publicTier = { id: "public", enrollment_open_at: OPEN, enrollment_close_at: LATER };

  it("removes a link-only tier for a visitor without an unlock", () => {
    expect(hideLinkOnlyTiers([linkOnly, publicTier]).map((c) => c.id)).toEqual(["public"]);
  });

  it("keeps a link-only tier for an unlocked link holder", () => {
    const unlocked = { ...linkOnly, priority_unlocked: true };
    expect(hideLinkOnlyTiers([unlocked, publicTier]).map((c) => c.id)).toEqual(["link-only", "public"]);
  });
});

// These pages fetch tiers in an effect, which a server-side render never runs,
// so the wiring is checked in the source.
describe("every public tier list leaves out link-only tiers", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), "src/app/(public)/enroll", path), "utf8");

  it.each([
    ["event page", "[slug]/page.tsx"],
    ["tickets page", "[slug]/tickets/page.tsx"],
  ])("%s hides them from the cards", (_name, path) => {
    expect(read(path)).toMatch(/hideLinkOnlyTiers\(/);
  });

  it.each([
    ["event page", "[slug]/page.tsx"],
    ["tickets page", "[slug]/tickets/page.tsx"],
    ["success page", "[slug]/success/page.tsx"],
    ["payment page", "payment/[ref]/page.tsx"],
  ])("%s leaves them out of its other tier list", (_name, path) => {
    expect(read(path)).toMatch(/!isLinkOnlyTier\(c\)/);
  });
});
