import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// ─── Ticket artwork must never be cropped, in any template ──────────────────
//
// Organisers upload 2:3 poster art whose information is banded top and bottom:
// sponsor logos above, venue / door time / hotline / date below. Rendering that
// into a short landscape box with `object-cover` keeps only the middle.
//
// Measured on the live staging page before this was fixed, with real artwork:
//
//   phone  375px : 600x900 poster into a 295x208 box -> 47% of the poster shown
//   laptop 1440px: 600x900 poster into a 250x256 box -> 68% shown
//
// At 47% the visible band was roughly source rows 238-661 of 900, which cut off
// the Heineken sponsor logo at the top and the venue, door time, hotline and
// date at the bottom. A cropped sponsor logo is a commercial problem, not a
// cosmetic one, which is why this is pinned across every template rather than
// fixed in the one that was reported.
//
// Nine of eleven templates had it wrong. A per-file fix would not stop the
// twelfth template from copying the same line, so this reads the source of
// every template instead of testing one component.

const TEMPLATE_DIR = join(process.cwd(), "src/components/enrollment/templates");

const templateFiles = readdirSync(TEMPLATE_DIR).filter(
  (f) => f.endsWith(".tsx") && !f.startsWith("index"),
);

/**
 * Every `<img>` element that renders class/ticket artwork, as one string each.
 *
 * Deliberately not line-based: the template that always got this right spreads
 * its `<img>` over several lines, and a per-line matcher reported it as broken.
 */
function ticketImageElements(source: string): string[] {
  return source
    .split("<img")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("/>")))
    .filter((el) => el.includes("src={cls.image_url}"));
}

describe("template inventory", () => {
  it("finds the templates to check", () => {
    expect(templateFiles.length).toBeGreaterThanOrEqual(10);
  });

  // Guards the matcher itself. If it silently stopped finding elements, every
  // assertion below would pass vacuously.
  it("finds ticket artwork in most of them", () => {
    const withArtwork = templateFiles.filter(
      (f) => ticketImageElements(readFileSync(join(TEMPLATE_DIR, f), "utf8")).length > 0,
    );
    expect(withArtwork.length).toBeGreaterThanOrEqual(10);
  });
});

describe.each(templateFiles)("%s", (file) => {
  const source = readFileSync(join(TEMPLATE_DIR, file), "utf8");
  const elements = ticketImageElements(source);

  it("never crops ticket artwork", () => {
    for (const el of elements) {
      expect(el, `${file} crops ticket artwork with object-cover`).not.toContain(
        "object-cover",
      );
    }
  });

  it("renders ticket artwork with object-contain", () => {
    for (const el of elements) {
      expect(el, `${file} must state object-contain explicitly`).toContain(
        "object-contain",
      );
    }
  });

  // A fixed height with a full width is the same bug wearing different
  // clothes: it forces the box to a ratio the poster does not have. Height
  // must be free to follow the image, bounded by max-h only.
  it("lets the artwork height follow the image", () => {
    for (const el of elements) {
      // The one legitimate fixed box is a small list thumbnail, which contains
      // rather than crops and so stays whole.
      const isThumbnail = el.includes("shrink-0");
      if (isThumbnail) continue;

      expect(el, `${file} pins ticket artwork to a fixed height`).toContain("h-auto");
    }
  });
});
