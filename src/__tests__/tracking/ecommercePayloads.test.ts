import { describe, expect, it } from "vitest";
import { beginCheckoutPayload, viewItemPayload } from "@/lib/tagManager";

describe("viewItemPayload", () => {
  it("lists one item per tier with id, name and price", () => {
    expect(
      viewItemPayload({
        slug: "ev",
        eventName: "Festival",
        currency: "MMK",
        tiers: [
          { id: "a", name: "GA", price: 1000 },
          { id: "b", name: "VIP", price: 5000 },
        ],
      }),
    ).toEqual({
      event_slug: "ev",
      event_name: "Festival",
      currency: "MMK",
      items: [
        { item_id: "a", item_name: "GA", price: 1000 },
        { item_id: "b", item_name: "VIP", price: 5000 },
      ],
    });
  });
});

describe("beginCheckoutPayload", () => {
  const base = { slug: "ev", eventName: "Festival", currency: "MMK" };

  it("sums price x quantity into value", () => {
    const p = beginCheckoutPayload({
      ...base,
      lines: [
        { id: "a", name: "GA", price: 1000, quantity: 3 },
        { id: "b", name: "VIP", price: 5000, quantity: 2 },
      ],
    });
    expect(p.value).toBe(13000);
    expect(p.items).toEqual([
      { item_id: "a", item_name: "GA", price: 1000, quantity: 3 },
      { item_id: "b", item_name: "VIP", price: 5000, quantity: 2 },
    ]);
  });

  it("is zero for no lines", () => {
    expect(beginCheckoutPayload({ ...base, lines: [] }).value).toBe(0);
  });
});
