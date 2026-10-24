import { describe, it, expect, vi } from "vitest";
import {
  admissionCount,
  attachPackSizes,
  computeOrderTotal,
  resolveOrderTotal,
} from "@/server/payments/platformFee";

// ─── per_ticket fee on package tiers ────────────────────────────────────────
//
// A "GA 3-Pack" line is quantity 1 at 125,000 but admits three people. The
// per_ticket fee charges per ticket, so it must count three, while pricing
// keeps using fee_amount x quantity (the package price).

const perTicket = { payment_mode: "mmqr", platform_fee_mode: "per_ticket", platform_fee_amount: 1000 };

/** A client whose tenants/classes lookups return the given rows. */
function client(classes: unknown, tenant: unknown = perTicket, classesError: unknown = null) {
  const from = vi.fn((table: string) => {
    if (table === "tenants") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tenant }) }) }),
      };
    }
    if (table === "classes") {
      return { select: () => ({ in: async () => ({ data: classes, error: classesError }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { from };
}

describe("admissionCount", () => {
  it("multiplies quantity by pack_size, defaulting to 1", () => {
    expect(admissionCount([{ fee_amount: 125000, quantity: 1, pack_size: 3 }, { fee_amount: 85000, quantity: 2 }])).toBe(5);
  });
});

describe("computeOrderTotal with packs", () => {
  it("charges the per_ticket fee per admission, not per pack", () => {
    const order = computeOrderTotal([{ fee_amount: 125000, quantity: 1, pack_size: 3 }], perTicket);
    expect(order).toEqual({ ticketSubtotal: 125000, platformFee: 3000, ticketCount: 3, total: 128000 });
  });

  it("leaves per_transaction unaffected", () => {
    const order = computeOrderTotal(
      [{ fee_amount: 125000, quantity: 1, pack_size: 3 }],
      { ...perTicket, platform_fee_mode: "per_transaction" },
    );
    expect(order.platformFee).toBe(1000);
  });
});

describe("attachPackSizes", () => {
  it("does not query unless the tenant charges per ticket", async () => {
    const c = client([]);
    const items = [{ class_id: "pack", fee_amount: 125000, quantity: 1 }];
    expect(await attachPackSizes(c, items, { platform_fee_mode: "none" })).toBe(items);
    expect(c.from).not.toHaveBeenCalled();
  });

  it("falls back to one ticket per unit when the lookup fails", async () => {
    const items = [{ class_id: "pack", fee_amount: 125000, quantity: 1 }];
    const out = await attachPackSizes(client(null, perTicket, { message: "boom" }), items, perTicket);
    expect(admissionCount(out)).toBe(1);
  });
});

describe("resolveOrderTotal with packs", () => {
  it("charges 3 x fee for one 3-pack on a cart order", async () => {
    const order = await resolveOrderTotal(client([{ id: "pack", pack_size: 3 }]), {
      tenant_id: "t1",
      enrollment_items: [{ class_id: "pack", fee_amount: 125000, quantity: 1 }],
    });
    expect(order.platformFee).toBe(3000);
    expect(order.total).toBe(128000);
  });

  it("charges per admission on a single-class order", async () => {
    const order = await resolveOrderTotal(client([{ id: "pack", pack_size: 3 }]), {
      tenant_id: "t1",
      quantity: 2,
      classes: { id: "pack", fee_amount: 220000 },
    });
    expect(order.ticketCount).toBe(6);
    expect(order.platformFee).toBe(6000);
  });
});
