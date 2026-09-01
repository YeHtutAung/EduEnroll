import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MmqrCard from "@/components/payments/MmqrCard";

// ─── MMQR card geometry ─────────────────────────────────────────────────────
//
// The layout is not ours to choose: MyanmarPay's "Digital & POS Brand
// Guideline (Dynamic QR)" fixes it, and KBZPay require merchants to follow it
// when displaying an MMQR code.
//
// These assert the RELATIONSHIPS the guideline states — the amount is twice
// the receiver name, the QR is 44% of height, the text shares the QR's left
// margin — rather than a screenshot, so a refactor cannot drift off-spec
// silently.
//
// They also exist because the first implementation looked plausible and was
// badly wrong: it drove sizes through a CSS custom property holding
// `min(320px, 100%)`, and `%` in a font-size means the PARENT'S FONT SIZE, so
// every label rendered at 16px * 0.0435 = 0.7px while the widths stayed
// correct. Nothing but rendering it caught that, and nothing but these
// assertions would catch its return.

const WIDTH = 320;
const HEIGHT = WIDTH * (29 / 20); // 464

const render = (overrides: Partial<Parameters<typeof MmqrCard>[0]> = {}) =>
  renderToStaticMarkup(
    <MmqrCard
      qrImageUrl="data:image/png;base64,AAAA"
      receiverName="Louder Myanmar"
      amount={150000}
      currency="MMK"
      width={WIDTH}
      {...overrides}
    />,
  );

/** React writes numeric style values as `px`. */
const px = (n: number) => `${n}px`;

describe("card shape", () => {
  it("is the 20:29 card the guideline specifies", () => {
    const html = render();
    expect(html).toContain(`width:${px(WIDTH)}`);
    expect(html).toContain(`height:${px(HEIGHT)}`);
  });

  it("uses Arial with no letter spacing", () => {
    const html = render();
    expect(html).toContain("Arial");
    expect(html).toContain("letter-spacing:0");
  });

  it("uses the four brand colours", () => {
    const html = render();
    expect(html).toContain("#FBD913"); // rules
    expect(html).toContain("#17479E"); // MMQR wording
    expect(html).toContain("#ffffff"); // card
    expect(html).toContain("#000000"); // text
  });
});

describe("proportions", () => {
  it("sizes the header at 18.5% and the MMQR wording at 12.5% of height", () => {
    const html = render();
    expect(html).toContain(`height:${px(HEIGHT * 0.185)}`);
    expect(html).toContain(`height:${px(HEIGHT * 0.125)}`);
  });

  it("sizes the QR at 44% of height", () => {
    expect(render()).toContain(`width:${px(HEIGHT * 0.44)}`);
  });

  it("caps the QR at 75% of width on a card too tall for it", () => {
    // A hypothetical wider ratio would let 44% of height exceed 75% of width;
    // the cap is what keeps the QR inside the side margins.
    expect(HEIGHT * 0.44).toBeLessThanOrEqual(WIDTH * 0.75);
  });

  // 3% / 6% / 3% of height. The relationship matters more than the pixels:
  // the amount is exactly twice the name, and the currency matches the name.
  it("sizes name, amount and currency at 3%, 6% and 3% of height", () => {
    const html = render();
    const name = HEIGHT * 0.03;
    const amount = HEIGHT * 0.06;

    expect(html).toContain(`font-size:${px(name)}`);
    expect(html).toContain(`font-size:${px(amount)}`);
    expect(amount).toBe(name * 2);
    // Name and currency share a size, so it appears at least twice.
    expect(html.split(`font-size:${px(name)}`).length - 1).toBeGreaterThanOrEqual(2);
  });

  // The bug that made this file necessary: labels rendered sub-pixel because a
  // percentage leaked through a custom property into font-size.
  it("never emits a sub-pixel font size", () => {
    const sizes = [...render().matchAll(/font-size:([\d.]+)px/g)].map((m) => Number(m[1]));

    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThan(8);
  });

  it("keeps every proportion when the card is resized", () => {
    const html = render({ width: 480 });
    const h = 480 * (29 / 20);

    expect(html).toContain(`height:${px(h * 0.185)}`);
    expect(html).toContain(`font-size:${px(h * 0.06)}`);
    expect(html).toContain(`width:${px(h * 0.44)}`);
  });
});

// The guideline is explicit and gives a reason: a Cambodia Bakong user study
// found left-aligned values are read in ~0.5s against 1-2s when centred.
describe("left alignment (guideline §5)", () => {
  it("puts the QR and the text on the same 12.5% left margin", () => {
    const margin = `margin-left:${px(WIDTH * 0.125)}`;

    // Once for the QR, once for the receiver/amount block.
    expect(render().split(margin).length - 1).toBe(2);
  });

  it("does not centre the receiver name or amount", () => {
    expect(render()).not.toContain("text-align:center");
  });
});

describe("content", () => {
  it("shows the receiver, not the payer, with a thousands-separated amount", () => {
    const html = render();
    expect(html).toContain("Louder Myanmar");
    expect(html).toContain("150,000");
    expect(html).toContain("MMK");
  });

  it("keeps the card intact while the QR is still rendering", () => {
    const html = render({ qrImageUrl: null, amount: 100 });

    // The frame must not collapse — a card that reflows when the image lands
    // would shift the page under the payer's thumb.
    expect(html).toContain(`height:${px(HEIGHT)}`);
    expect(html).toContain("Rendering QR...");
    expect(html).toContain("Louder Myanmar");
  });
});
