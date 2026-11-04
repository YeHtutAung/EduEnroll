import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ETicketEmailNotice from "@/components/payments/ETicketEmailNotice";

const render = (orgType: string | null | undefined, ticketCount: number | null) =>
  renderToStaticMarkup(<ETicketEmailNotice orgType={orgType} ticketCount={ticketCount} />);

describe("ETicketEmailNotice", () => {
  it("tells an event buyer with tickets to look in their email, in both languages", () => {
    const html = render("event", 1);
    expect(html).toContain("You will get your e-tickets via email");
    expect(html).toContain("သင့် E-Ticket များကို email မှတစ်ဆင့် ရရှိပါမည်");
    expect(html).toContain("Check your inbox and spam folder.");
  });

  it("only animates the icon for buyers who have not asked for reduced motion", () => {
    const html = render("event", 1);
    expect(html).toContain("motion-safe:animate-mail-nudge");
    expect(html).toContain("motion-safe:animate-mail-ring");
    expect(html).not.toMatch(/[\s"]animate-mail-/);
  });

  it("promises nothing while the tickets are unknown", () => {
    expect(render("event", null)).toBe("");
  });

  it("promises nothing when no ticket was issued", () => {
    expect(render("event", 0)).toBe("");
  });

  it.each(["language_school", "training_center", "", null, undefined])(
    "stays hidden for org type %s",
    (orgType) => {
      expect(render(orgType, 1)).toBe("");
    },
  );
});
