import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The payment page's "Get Tickets" / "Enroll" link hardcoded white text on the
// tenant's primary colour, so on BeatsRun's yellow buyers could barely read it.
//
// Checked in the source because the page loads its data in an effect, which a
// server-side render never runs. readableTextColor has its own tests.

const PAGE = readFileSync(join(process.cwd(), "src/app/(public)/enroll/payment/[ref]/page.tsx"), "utf8");

const label = PAGE.indexOf('"Get Tickets" : "Enroll"');
const link = PAGE.slice(PAGE.lastIndexOf("<a", label), label);

describe("payment page other-tickets link", () => {
  it("finds the link", () => {
    expect(link).toContain("backgroundColor: primaryColor");
  });

  it("chooses a readable text colour for the tenant's colour", () => {
    expect(link).toContain("color: readableTextColor(primaryColor)");
  });

  it("does not hardcode white text", () => {
    expect(link).not.toContain("text-white");
  });
});
