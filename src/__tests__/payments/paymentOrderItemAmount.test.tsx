import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderItemAmount } from "@/components/payments/OrderItemAmount";

async function renderAmount(props: {
  subtotal: number;
  unitPrice: number | null;
  quantity: number;
  currency: string;
}) {
  return renderToStaticMarkup(<OrderItemAmount {...props} />);
}

describe("confirmed payment order-item amounts", () => {
  it("uses the cart item's supplied unit price rather than deriving it from the subtotal", async () => {
    const html = await renderAmount({
      subtotal: 4_000,
      unitPrice: 2_000,
      quantity: 2,
      currency: "MMK",
    });

    expect(html).toContain("4,000 MMK");
    expect(html).toContain("2,000 MMK × 2");
  });

  it("keeps the single-class subtotal but omits an unknown unit price", async () => {
    const html = await renderAmount({
      subtotal: 4_000,
      unitPrice: null,
      quantity: 2,
      currency: "MMK",
    });

    expect(html).toContain("4,000 MMK");
    expect(html).not.toContain("× 2");
    expect(html).not.toContain("text-xs text-gray-400");
  });
});
