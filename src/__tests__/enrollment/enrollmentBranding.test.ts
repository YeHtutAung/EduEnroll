import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// ─── The e-ticket API must read the real appearance table ───────────────────
//
// It queried `tenant_appearances` — plural, and no such table exists. The error
// was never checked and every field collapsed through `appearance?.x ?? null`,
// so each e-ticket silently lost its tenant logo, brand colour and sponsor
// settings. Confirmed against live staging: logo_url, brand_color and
// sponsor_config all returned null for a tenant that has all three set.
//
// Asserted against the source. A table-name typo is invisible to a test whose
// mock answers to whatever name it is given — the mock would happily serve
// `tenant_appearances` and the suite would pass while production returned
// nothing. The name itself is the thing under test.

const ROUTE = "src/app/api/public/enrollment/[ref]/route.ts";
const src = readFileSync(path.join(process.cwd(), ROUTE), "utf8");

/** Comments name the wrong table to explain the bug, so strip them first. */
const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("enrollment API branding lookup", () => {
  it("queries the singular tenant_appearance table", () => {
    expect(code).toContain('.from("tenant_appearance")');
    expect(code).not.toContain('.from("tenant_appearances")');
  });

  it("checks the appearance lookup error instead of swallowing it", () => {
    // `appearance?.x ?? null` alone made a broken query indistinguishable from
    // a tenant with no branding, which is how the typo survived unnoticed.
    expect(code).toMatch(/appearanceResult\.error/);
    expect(code).toMatch(/console\.error/);
  });

  it("still returns branding fields to the client", () => {
    // The response shape the success page and e-ticket depend on.
    for (const field of ["logo_url", "brand_color", "sponsor_config"]) {
      expect(code).toContain(field);
    }
  });
});

// ─── The sample sponsor constant is gone, not merely unused ─────────────────

describe("sample sponsor placements", () => {
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("no longer exists anywhere in src", () => {
    // Keeping it exported "for previews" invites the reuse that caused the
    // incident: it had no runtime consumer, and a fallback naming invented
    // sponsors has no safe caller.
    const files = [
      "src/types/database.ts",
      "src/lib/sponsors.ts",
      "src/app/(public)/enroll/[slug]/checkout/success/page.tsx",
      "src/app/admin/appearance/page.tsx",
    ];
    for (const f of files) {
      const c = strip(readFileSync(path.join(process.cwd(), f), "utf8"));
      expect(c, `${f} still references the sample constant`).not.toContain(
        "DEFAULT_SPONSOR_PLACEMENTS",
      );
      for (const sample of ["Northwind", "Orbit"]) {
        expect(c, `${f} still hardcodes ${sample}`).not.toContain(sample);
      }
    }
  });
});

// ─── Both e-ticket renderers bound sponsor wordmarks ────────────────────────

describe("e-ticket sponsor wordmarks", () => {
  const ticketSrc = readFileSync(
    path.join(process.cwd(), "src/app/(public)/enroll/[slug]/checkout/success/page.tsx"),
    "utf8",
  );

  it("bounds the wordmark in both the canvas and PDF renderers", () => {
    // `maxLogoWidth` constrained the LOGO branch only. A text-only sponsor, or
    // one whose logo failed to load and fell through to the wordmark, could
    // still overrun its slot and collide with the next name in the strip.
    // The canvas twin was fixed first; the PDF one was missed.
    const budgets = ticketSrc.match(/wordBudget/g) ?? [];
    expect(budgets.length, "expected a width budget in BOTH renderers").toBeGreaterThanOrEqual(4);

    // Neither renderer may draw the raw, unmeasured name.
    expect(ticketSrc).not.toMatch(/fillText\(\s*sponsor\.name\s*,/);
    expect(ticketSrc).not.toMatch(/pdf\.text\(\s*sponsor\.name\s*,/);
  });
});
