import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The form page's Next and Submit buttons hardcoded white text on the tenant's
// primary colour, so on BeatsRun's yellow buyers could barely read them.
//
// Checked in the source because the page loads its colour in an effect, which a
// server-side render never runs. readableTextColor has its own tests.

const FORM = readFileSync(join(process.cwd(), "src/app/(public)/enroll/form/page.tsx"), "utf8");

/** Each element that paints the tenant's primary colour as its background. */
const primaryButtons = FORM.split("<button")
  .slice(1)
  .map((tag) => tag.slice(0, tag.indexOf(">")))
  .filter((tag) => tag.includes("backgroundColor: primaryColor"));

describe("form page primary buttons", () => {
  it("finds the Next and Submit buttons", () => {
    expect(primaryButtons).toHaveLength(2);
  });

  it("chooses a readable text colour for the tenant's colour", () => {
    for (const tag of primaryButtons) {
      expect(tag).toContain("color: readableTextColor(primaryColor)");
    }
  });

  it("does not hardcode white text", () => {
    for (const tag of primaryButtons) {
      expect(tag).not.toContain("text-white");
    }
  });
});
