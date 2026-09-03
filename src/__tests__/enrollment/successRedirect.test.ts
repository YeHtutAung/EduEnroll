import { describe, it, expect } from "vitest";
import { successRedirectUrl } from "@/lib/enrollment/successRedirect";

// ─── A paid buyer must never be sent to a 404 ───────────────────────────────
//
// The HitPay poll defaulted a nullable `intake_slug` with `?? ""`, producing
// `/enroll//checkout/success/`. That path does not exist, and the person
// following it has already paid.

describe("successRedirectUrl", () => {
  it("builds the success URL when there is an intake slug", () => {
    expect(successRedirectUrl("october-2026", "LM-0902-3SJQ")).toBe(
      "/enroll/october-2026/checkout/success/?ref=LM-0902-3SJQ",
    );
  });

  // The defect, stated as a test: every one of these used to yield a URL with
  // an empty path segment.
  it.each([null, undefined, "", "   "])(
    "returns null rather than an empty segment for slug %p",
    (slug) => {
      expect(successRedirectUrl(slug, "LM-0902-3SJQ")).toBeNull();
    },
  );

  // The property, rather than the examples: whatever the slug, the result is
  // either null or a path containing no collapsed segment. `//` IS the defect —
  // `/enroll//checkout/success/` is what `?? ""` produced.
  //
  // Checked as "no //" rather than "no empty split element": the URL ends in a
  // trailing slash by design, so splitting yields a final empty string that has
  // nothing to do with the bug.
  it.each([null, undefined, "", "   ", "october-2026", "a/b", "wê1"])(
    "never collapses to a // path (slug %p)",
    (slug) => {
      const url = successRedirectUrl(slug, "LM-0902-3SJQ");
      if (url === null) return;
      expect(url.split("?")[0]).not.toContain("//");
    },
  );

  it("returns null without an enrollment ref, which would also 404", () => {
    expect(successRedirectUrl("october-2026", "")).toBeNull();
  });

  it("encodes both segments", () => {
    const url = successRedirectUrl("a/b", "LM 09/02");
    expect(url).toBe("/enroll/a%2Fb/checkout/success/?ref=LM%2009%2F02");
  });
});
