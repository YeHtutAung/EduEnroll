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
