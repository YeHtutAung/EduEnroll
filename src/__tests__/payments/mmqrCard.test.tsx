import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MmqrCard from "@/components/payments/MmqrCard";

// ─── MMQR card geometry ─────────────────────────────────────────────────────
//
// The layout is not ours to choose: MyanmarPay's "Digital & POS Brand
// Guideline (Dynamic QR)" fixes it, and KBZPay require merchants to follow it
// when displaying an MMQR code.
//
// The card is an SVG on a 500x725 viewBox, so these assert coordinates in
// viewBox units. That is the whole point of the SVG: the proportions are fixed
// in the markup and the browser scales them, so "does it hold its shape at
// 240px" stops being a question anyone has to test.
//
// Two earlier CSS attempts failed and are worth remembering, because both
// looked correct in code review:
//
//   1. A custom property holding `min(320px, 100%)` with `calc(var(--w) * k)`
//      sizes. `%` inside a custom property is re-resolved per property, and in
//      font-size it means the parent's font size — every label rendered at
//      0.7px while the widths stayed right.
//   2. Fixed pixels with `maxWidth: 100%`. Measured in the real panel on a
//      320px phone: a 240x464 card, ratio 1.93 against the required 1.45, QR
//      overflowing. Caught in review of PR #238.

const VB_W = 500;
const VB_H = 725;

const render = (overrides: Partial<Parameters<typeof MmqrCard>[0]> = {}) =>
  renderToStaticMarkup(
    <MmqrCard
      qrImageUrl="data:image/png;base64,AAAA"
      receiverName="Louder Myanmar"
      amount={150000}
      currency="MMK"
      {...overrides}
    />,
  );

describe("card shape", () => {
  it("is the 20:29 card the guideline specifies", () => {
    expect(render()).toContain(`viewBox="0 0 ${VB_W} ${VB_H}"`);
    expect(VB_H / VB_W).toBeCloseTo(29 / 20, 5);
  });

  it("uses Arial with no letter spacing", () => {
    const html = render();
    expect(html).toContain("Arial");
    expect(html).toContain('letter-spacing="0"');
  });

  it("uses the four brand colours", () => {
    const html = render();
    expect(html).toContain("#FBD913"); // rules
    expect(html).toContain("#17479E"); // MMQR wording
    expect(html).toContain("#ffffff"); // card
    expect(html).toContain("#000000"); // text
  });
});

// The findings that produced this shape. A viewBox cannot drift: the ratio
// lives in the markup, not in a computed style.
describe("responsive behaviour", () => {
  it("scales to its container rather than assuming a width", () => {
    const html = render();
    expect(html).toContain("width:100%");
    expect(html).toContain("height:auto");
  });

  it("accepts a cap without changing any internal geometry", () => {
    const wide = render({ maxWidth: 480 });
    const narrow = render({ maxWidth: 200 });

    expect(wide).toContain("max-width:480px");
    expect(narrow).toContain("max-width:200px");

    // Same viewBox, same coordinates — only the rendered size differs.
    expect(wide).toContain(`viewBox="0 0 ${VB_W} ${VB_H}"`);
    expect(narrow).toContain(`viewBox="0 0 ${VB_W} ${VB_H}"`);
    expect(wide.replace(/max-width:480px/, "X")).toBe(narrow.replace(/max-width:200px/, "X"));
  });

  // Both previous bugs were a length that meant different things in different
  // places. Neither construct may return.
  it("uses no percentage arithmetic and no fixed pixel geometry", () => {
    const html = render();
    expect(html).not.toContain("calc(");
    expect(html).not.toContain("--mmqr-w");
    expect(html).not.toContain("max-width:100%");
  });
});

describe("proportions", () => {
  it("sizes the header at 18.5% and the MMQR wording at 12.5% of height", () => {
    const html = render();
    // The header rule sits at the header's full height.
    expect(html).toContain(`y1="${VB_H * 0.185}"`);
    // Wording baseline sits inside the 12.5% band that follows it.
    expect(html).toContain(`font-size="${VB_H * 0.125 * 0.42}"`);
  });

  it("sizes the QR at 44% of height", () => {
    expect(render()).toContain(`width="${VB_H * 0.44}"`);
  });

  it("caps the QR at 75% of width", () => {
    expect(VB_H * 0.44).toBeLessThanOrEqual(VB_W * 0.75);
  });

  it("sizes name, amount and currency at 3%, 6% and 3% of height", () => {
    const html = render();
    const name = VB_H * 0.03;
    const amount = VB_H * 0.06;

    expect(html).toContain(`font-size="${name}"`);
    expect(html).toContain(`font-size="${amount}"`);
    expect(amount).toBe(name * 2);
  });
});

// Explicit in the guideline, with a cited reason: a Cambodia Bakong user study
// found left-aligned values are read in ~0.5s against 1-2s when centred.
describe("left alignment (guideline §5)", () => {
  it("puts the QR and the text on the same 12.5% left margin", () => {
    const margin = VB_W * 0.125;
    const html = render();

    expect(html).toContain(`x="${margin}"`);
    // QR, receiver name and amount all start there.
    expect(html.split(`x="${margin}"`).length - 1).toBeGreaterThanOrEqual(3);
  });

  it("centres only the MMQR wording", () => {
    expect(render().split('text-anchor="middle"').length - 1).toBe(1);
  });
});

describe("content", () => {
  it("shows the receiver, not the payer, with a thousands-separated amount", () => {
    const html = render();
    expect(html).toContain("Louder Myanmar");
    expect(html).toContain("150,000");
    expect(html).toContain("MMK");
  });

  it("describes itself for screen readers", () => {
    expect(render()).toContain('aria-label="MMQR payment code for 150,000 MMK to Louder Myanmar"');
  });

  it("keeps the card intact while the QR is still rendering", () => {
    const html = render({ qrImageUrl: null, amount: 100 });

    // The frame must not collapse — a card that reflows when the image lands
    // would shift the page under the payer's thumb. With a viewBox it cannot.
    expect(html).toContain(`viewBox="0 0 ${VB_W} ${VB_H}"`);
    expect(html).toContain("Rendering QR...");
    expect(html).toContain("Louder Myanmar");
  });
});
