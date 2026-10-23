import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EvLuxuryTemplate from "@/components/enrollment/templates/EvLuxuryTemplate";
import type { EventTemplateProps, TemplateClass } from "@/components/enrollment/templates/types";
import { DEFAULT_APPEARANCE } from "@/types/database";
import { formatCurrency } from "@/lib/utils";

// The mobile-only bottom bar ("Tickets available · Buy Tickets") must follow
// the cards' own buyability rule. During a pre-registration window every tier
// is "not open yet" for an ordinary visitor; showing the bar there advertised
// tickets nobody could buy and covered the Register Interest bar.

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const tier = (over: Partial<TemplateClass> = {}): TemplateClass => ({
  id: "c1",
  level: "Pre-registration - 10KM",
  fee_amount: 75000,
  fee_formatted: "75,000 MMK",
  seat_remaining: 500,
  seat_total: 500,
  enrollment_open_at: null,
  enrollment_close_at: null,
  status: "open",
  ...over,
});

function render(classes: TemplateClass[]): string {
  const props: EventTemplateProps = {
    appearance: { ...DEFAULT_APPEARANCE, template_id: "ev-luxury" },
    intake: { id: "i1", name: "December 2026 Event", year: 2026, status: "open" },
    classes,
    labels: { intake: "Event", class: "Ticket", student: "Attendee", seat: "Seat", fee: "Fee", orgType: "event", currency: "MMK" },
    slug: "december-2026",
    currency: "MMK",
    onSelect: () => {},
    onCartCheckout: () => {},
  };
  return renderToStaticMarkup(createElement(EvLuxuryTemplate, props));
}

describe("EvLuxuryTemplate mobile Buy Tickets bar", () => {
  it("is hidden while every tier is not on sale yet (pre-registration)", () => {
    const html = render([tier({ enrollment_open_at: iso(7 * DAY) })]);
    expect(html).not.toContain("Buy Tickets");
  });

  it("shows for a pre-registration link holder whose tier is unlocked", () => {
    const html = render([tier({ enrollment_open_at: iso(7 * DAY), priority_unlocked: true })]);
    expect(html).toContain("Buy Tickets");
  });

  it("shows once a tier is on public sale", () => {
    expect(render([tier()])).toContain("Buy Tickets");
  });

  it("is hidden when the only tiers are closed or sold out", () => {
    expect(render([tier({ enrollment_close_at: iso(-DAY) })])).not.toContain("Buy Tickets");
    expect(render([tier({ seat_remaining: 0 })])).not.toContain("Buy Tickets");
  });

  it("quotes the lowest price among buyable tiers only", () => {
    const html = render([
      tier({ id: "a", fee_amount: 50000, enrollment_open_at: iso(7 * DAY) }), // not on sale
      tier({ id: "b", level: "Final Tier", fee_amount: 95000 }),
    ]);
    expect(html).toContain(`From ${formatCurrency(95000, "MMK")}`);
    expect(html).not.toContain(`From ${formatCurrency(50000, "MMK")}`);
  });
});
