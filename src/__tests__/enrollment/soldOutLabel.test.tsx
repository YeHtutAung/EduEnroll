import { describe, it, expect, vi } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_APPEARANCE } from "@/types/database";
import { soldOutLabel, type TemplateClass } from "@/components/enrollment/templates/types";
import * as templates from "@/components/enrollment/templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

// An organiser can replace a tier's "SOLD OUT" with their own words. A tier
// without any must look exactly as before, in every template.

const CUSTOM = "Day 1 is full, see you on Day 2";

function tier(over: Partial<TemplateClass>): TemplateClass {
  return {
    id: "c1",
    level: "Day 1",
    fee_amount: 30000,
    fee_formatted: "30,000 MMK",
    seat_remaining: 0,
    seat_total: 1000,
    enrollment_open_at: null,
    enrollment_close_at: null,
    status: "full",
    ...over,
  };
}

const labels = {
  intake: "Event", class: "Ticket", student: "Buyer", seat: "Seat", fee: "Price",
  orgType: "event", currency: "MMK",
};

function render(name: keyof typeof templates, classes: TemplateClass[]): string {
  const Component = templates[name] as unknown as ComponentType<Record<string, unknown>>;
  return renderToStaticMarkup(
    createElement(Component, {
      appearance: DEFAULT_APPEARANCE,
      intake: { id: "i1", name: "Sky Fest", year: 2026, status: "open" },
      classes,
      labels,
      slug: "sky",
      currency: "MMK",
      onSelect: () => {},
      onSelectClass: () => {},
      onCartCheckout: () => {},
    }),
  );
}

describe("soldOutLabel", () => {
  it("returns the trimmed text, or null when there is none", () => {
    expect(soldOutLabel({ sold_out_label: `  ${CUSTOM} ` })).toBe(CUSTOM);
    expect(soldOutLabel({ sold_out_label: "   " })).toBeNull();
    expect(soldOutLabel({ sold_out_label: null })).toBeNull();
    expect(soldOutLabel({})).toBeNull();
  });
});

// Each template's own wording for a full tier, unchanged from before.
const DEFAULTS: [keyof typeof templates, string][] = [
  ["EvFestivalTemplate", "SOLD OUT"],
  ["EvCorporateTemplate", "Sold Out"],
  ["EvLuxuryTemplate", "SOLD OUT /"],
  ["EvTrustedOfficialTemplate", "Sold Out"],
  ["LsClassicTemplate", "FULL"],
  ["LsModernTemplate", "Full"],
  ["LsWarmTemplate", "Class Full"],
  ["MinimalTemplate", "FULL —"],
  ["BoldTemplate", "FULL /"],
  ["WarmTemplate", "Full /"],
  ["ProfessionalTemplate", "နေရာပြည့်သွားပြီ"],
];

describe.each(DEFAULTS)("%s", (name, fallback) => {
  it("shows the organiser's text on a sold-out tier", () => {
    const html = render(name, [tier({ sold_out_label: CUSTOM })]);
    expect(html).toContain(CUSTOM);
  });

  it("keeps its own wording when no text is set", () => {
    const html = render(name, [tier({ sold_out_label: null })]);
    expect(html).toContain(fallback);
    expect(html).not.toContain(CUSTOM);
  });

  it("doesn't show the text while the tier is still on sale", () => {
    const html = render(name, [tier({ status: "open", seat_remaining: 10, sold_out_label: CUSTOM })]);
    expect(html).not.toContain(CUSTOM);
  });
});

// Luxury says it twice: the banner over the poster and the seats badge.
describe("EvLuxuryTemplate seats badge", () => {
  it("uses the organiser's text too, so no SOLD OUT is left", () => {
    const html = render("EvLuxuryTemplate", [tier({ sold_out_label: CUSTOM })]);
    expect(html.split(CUSTOM).length - 1).toBe(2);
    expect(html).not.toContain("SOLD OUT");
  });

  it("keeps SOLD OUT in both places without it", () => {
    const html = render("EvLuxuryTemplate", [tier({ sold_out_label: null })]);
    expect(html.split("SOLD OUT").length - 1).toBe(2);
  });
});

// A second, separate text for the Luxury seats box: green, in place of "N left".
describe("EvLuxuryTemplate seats box text", () => {
  it("shows it in green instead of the red sold-out box, banner untouched", () => {
    const html = render("EvLuxuryTemplate", [tier({ sold_out_badge_label: " COMING SOON " })]);
    expect(html).toMatch(/color:#86efac[^>]*>COMING SOON</);
    expect(html.split("SOLD OUT").length - 1).toBe(1); // only the banner
    expect(html).not.toContain("border-red-500/30");
  });

  it("works next to the organiser's sold-out text", () => {
    const html = render("EvLuxuryTemplate", [tier({ sold_out_label: CUSTOM, sold_out_badge_label: "COMING SOON" })]);
    expect(html.split(CUSTOM).length - 1).toBe(1);
    expect(html).toContain("COMING SOON");
  });

  it("doesn't show while the tier is on sale", () => {
    const html = render("EvLuxuryTemplate", [tier({ status: "open", seat_remaining: 10, sold_out_badge_label: "COMING SOON" })]);
    expect(html).not.toContain("COMING SOON");
    expect(html).toContain("10 left");
  });
});

// These badges space out and capitalise their own wording. The organiser's text
// is shown as typed: wide letter spacing pulls Burmese marks apart.
describe.each([
  "LsClassicTemplate", "LsWarmTemplate", "BoldTemplate", "MinimalTemplate", "EvLuxuryTemplate",
] as const)("%s keeps the organiser's text as typed", (name) => {
  it("turns off the badge's capitals and letter spacing for it", () => {
    const html = render(name, [tier({ sold_out_label: CUSTOM })]);
    expect(html).toContain(`<span class="normal-case tracking-normal">${CUSTOM}</span>`);
  });
});
