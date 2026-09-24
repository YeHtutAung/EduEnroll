import { describe, expect, it } from "vitest";
import { organiserRulesFingerprint } from "@/server/legal/organiserRules";
import { normaliseOrganiserTerms, ORGANISER_TERMS_MAX } from "@/lib/legal/terms";

describe("organiserRulesFingerprint", () => {
  it("is null when no event has rules", () => {
    expect(organiserRulesFingerprint([])).toBeNull();
    expect(organiserRulesFingerprint([{ id: "a", organiser_terms: null }])).toBeNull();
    expect(organiserRulesFingerprint([{ id: "a", organiser_terms: "   " }])).toBeNull();
  });

  it("is a stable sha256 hex digest of the same rules", () => {
    const rows = [{ id: "a", organiser_terms: "No outside food." }];
    const first = organiserRulesFingerprint(rows);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(organiserRulesFingerprint(rows)).toBe(first);
  });

  // The whole point: an organiser editing their rules must invalidate an
  // acceptance given against the old wording.
  it("changes when the wording changes", () => {
    expect(organiserRulesFingerprint([{ id: "a", organiser_terms: "No outside food." }])).not.toBe(
      organiserRulesFingerprint([{ id: "a", organiser_terms: "No outside food or drink." }]),
    );
  });

  it("does not depend on the order events arrive in", () => {
    const a = { id: "a", organiser_terms: "Rule A" };
    const b = { id: "b", organiser_terms: "Rule B" };
    expect(organiserRulesFingerprint([a, b])).toBe(organiserRulesFingerprint([b, a]));
  });
});

describe("normaliseOrganiserTerms", () => {
  it("trims, and turns empty into null", () => {
    expect(normaliseOrganiserTerms("  Bags are searched.  ")).toBe("Bags are searched.");
    expect(normaliseOrganiserTerms("   ")).toBeNull();
    expect(normaliseOrganiserTerms(null)).toBeNull();
  });

  it("caps at the documented length", () => {
    expect(ORGANISER_TERMS_MAX).toBe(5000);
  });
});
