import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PackBadge from "@/components/enrollment/templates/PackBadge";
import { cartTicketCount, packInfo } from "@/components/enrollment/templates/types";

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

// The cart bar's "N tickets in cart" label: one 3-pack is three tickets.
describe("cartTicketCount", () => {
  const classes = [
    { id: "pack", pack_size: 3 },
    { id: "vip", pack_size: 1 },
    { id: "legacy" }, // no pack_size: a pre-package response
  ];

  it("counts one 3-pack as 3 tickets", () => {
    expect(cartTicketCount(classes, [["pack", 1]])).toBe(3);
  });

  it("adds packs and ordinary tickets together", () => {
    expect(cartTicketCount(classes, [["pack", 2], ["vip", 1], ["legacy", 2]])).toBe(9);
  });

  it("counts a line whose tier is not in the list as one per unit", () => {
    expect(cartTicketCount(classes, [["unknown", 2]])).toBe(2);
  });

  it("is 0 for an empty cart", () => {
    expect(cartTicketCount(classes, [])).toBe(0);
  });
});
