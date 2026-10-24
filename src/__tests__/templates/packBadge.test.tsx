import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PackBadge from "@/components/enrollment/templates/PackBadge";
import { packInfo } from "@/components/enrollment/templates/types";

// Louder Myanmar's promotion: 3 GA for 125,000 (single GA 45,000) and
// 3 VIP for 220,000 (single VIP 85,000).
describe("packInfo", () => {
  it("is null for an ordinary tier", () => {
    expect(packInfo({ fee_amount: 45000, pack_size: 1, compare_at_amount: null })).toBeNull();
    expect(packInfo({ fee_amount: 45000 })).toBeNull();
  });

  it("reports the saving against the regular price", () => {
    expect(packInfo({ fee_amount: 125000, pack_size: 3, compare_at_amount: 135000 })).toEqual({ size: 3, savings: 10000 });
    expect(packInfo({ fee_amount: 220000, pack_size: 3, compare_at_amount: 255000 })).toEqual({ size: 3, savings: 35000 });
  });

  it("never advertises a zero or negative saving", () => {
    expect(packInfo({ fee_amount: 125000, pack_size: 3, compare_at_amount: 125000 })?.savings).toBeNull();
    expect(packInfo({ fee_amount: 125000, pack_size: 3, compare_at_amount: 100000 })?.savings).toBeNull();
    expect(packInfo({ fee_amount: 125000, pack_size: 3, compare_at_amount: null })?.savings).toBeNull();
  });
});

describe("PackBadge", () => {
  it("renders nothing for an ordinary tier", () => {
    expect(renderToStaticMarkup(<PackBadge cls={{ fee_amount: 45000, pack_size: 1 }} currency="MMK" />)).toBe("");
  });

  it("shows ticket count and saving for a package", () => {
    const html = renderToStaticMarkup(
      <PackBadge cls={{ fee_amount: 125000, pack_size: 3, compare_at_amount: 135000 }} currency="MMK" />,
    );
    expect(html).toContain("3 tickets per package");
    expect(html).toContain("Save 10,000 MMK");
  });
});
