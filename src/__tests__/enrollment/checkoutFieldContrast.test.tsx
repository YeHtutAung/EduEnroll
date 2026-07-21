import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// ─── The checkout form must stay readable on a dark-mode device ─────────────
//
// globals.css carried the create-next-app scaffold, which flipped --foreground
// to #ededed under `prefers-color-scheme: dark`. Tailwind's preflight sets
// `color: inherit` on form controls, and the checkout inputs set only a border,
// so on a dark-mode phone they rendered near-white text on their hardcoded
// white background: about 1.2:1 against a 4.5:1 minimum. Buyers could not read
// what they typed while paying, and the page still LOOKED fine because every
// panel hardcodes a light colour — only the inherited text colour changed.
//
// Two independent guards, because either alone would have prevented it:
//   1. no dark-mode override of the global foreground
//   2. the inputs state their own colour rather than inheriting
//
// Asserted against the source rather than a rendered tree: the bug lives in the
// CSS cascade (a media query plus preflight inheritance), which does not exist
// in renderToStaticMarkup output, and jsdom does not evaluate media queries.
// Measured in a real browser instead — dark mode now yields #0f1f42 on #ffffff.

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

/** Comments explain the bug and name the thing being banned, so they must not
 *  count as the thing being banned. */
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const GLOBALS = "src/app/globals.css";
const CHECKOUT = "src/app/(public)/enroll/[slug]/checkout/page.tsx";

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("checkout form readability", () => {
  it("globals.css does not override the foreground colour for dark mode", () => {
    const css = withoutComments(read(GLOBALS));

    // The scaffold block. Its presence is the root cause, regardless of what
    // any individual input does.
    expect(css).not.toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).not.toContain("#ededed");
  });

  it("globals.css declares a colour scheme so the OS cannot darken controls", () => {
    // Without this iOS Safari darkens control internals even when the CSS does
    // not ask it to.
    expect(withoutComments(read(GLOBALS))).toMatch(/color-scheme:\s*light/);
  });

  it("checkout fields state their own colour and background", () => {
    const src = read(CHECKOUT);
    const m = src.match(/const borderStyle[\s\S]*?\}\);/);

    expect(m, "borderStyle helper not found").not.toBeNull();
    expect(m![0]).toMatch(/color:\s*"#0f1f42"/);
    expect(m![0]).toMatch(/background:\s*"#ffffff"/);
  });

  it("the stated field colours clear the WCAG AA threshold", () => {
    // Guards the values themselves: stating a colour is no use if it is a pale
    // one. 4.5:1 is the AA minimum for body text.
    expect(contrast("#0f1f42", "#ffffff")).toBeGreaterThanOrEqual(4.5);

    // The regression, for reference: near-white on white.
    expect(contrast("#ededed", "#ffffff")).toBeLessThan(1.5);
  });
});
