import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CbMmqrCard from "@/components/payments/CbMmqrCard";

// CB require their WebFrame sample layout (email of 2026-10-29). Coordinates
// are viewBox units on 500x725 (20:29, CB's UI guideline).

const render = (over: Partial<Parameters<typeof CbMmqrCard>[0]> = {}) =>
  renderToStaticMarkup(
    <CbMmqrCard qrImageUrl="data:image/png;base64,AAAA" receiverName="The Beats Run" amount={40000} currency="MMK" {...over} />,
  );
const attr = (svg: string, tagWith: string, name: string) => {
  const tag = svg.match(new RegExp(`<[^>]*${tagWith}[^>]*>`))?.[0] ?? "";
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
};

describe("CbMmqrCard", () => {
  it("is a 500x725 SVG that scales to its container", () => {
    const svg = render();
    expect(svg).toContain('viewBox="0 0 500 725"');
    expect(svg).toContain('data-testid="cb-mmqr-card"');
  });

  it("puts the QR at 80% of the width, centred", () => {
    const svg = render();
    expect(attr(svg, 'href="data:image/png', "width")).toBe("400");
    expect(attr(svg, 'href="data:image/png', "x")).toBe("50");
  });

  it("left-aligns receiver and amount at the 12.5% inset, amount with two decimals", () => {
    const svg = render();
    expect(svg).toMatch(/<text[^>]*x="62.5"[^>]*text-anchor="start"[^>]*>The Beats Run<\/text>/);
    expect(svg).toContain("40,000.00");
    expect(svg).toContain("MMK");
  });

  it("writes MMQR in black, not blue", () => {
    expect(render()).toMatch(/<text[^>]*fill="#000000"[^>]*>MMQR<\/text>/);
  });

  it("shows CB's logo at 20% width, centred below the QR, and no mark inside the QR", () => {
    const svg = render();
    expect(attr(svg, 'cb-bank-logo.png', "width")).toBe("100");
    expect(attr(svg, 'cb-bank-logo.png', "x")).toBe("200");
    expect(svg.match(/<image/g)).toHaveLength(3); // banner, QR, CB logo
  });

  it("has the #264EA1 bottom rule and a grey border", () => {
    const svg = render();
    expect(svg).toContain('stroke="#264EA1"');
    expect(svg).toContain('stroke="#808080"');
  });

  it("shows a placeholder while the QR is rendering", () => {
    expect(render({ qrImageUrl: null })).toContain("Rendering QR...");
  });

  it("fits inside 20:29 with the measured assets", () => {
    const svg = render();
    const y = Number(attr(svg, "cb-bank-logo.png", "y"));
    const h = Number(attr(svg, "cb-bank-logo.png", "height"));
    expect(y + h).toBeLessThan(725 - 4);
  });
});
