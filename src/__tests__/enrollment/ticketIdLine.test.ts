import { describe, expect, it } from "vitest";
import { pdfHolder, ticketIdLine } from "@/lib/tickets/ticketLayout";

const JTI = "b131e09c-1111-2222-3333-444444444444";

describe("ticketIdLine", () => {
  it("is unchanged for a ticket without a runner", () => {
    expect(ticketIdLine({ jti: JTI, index: 0, count: 1, sep: " · " })).toBe("Ticket #b131e09c");
    expect(ticketIdLine({ jti: JTI, index: 1, count: 3, sep: " · " })).toBe("Ticket #b131e09c · 2 of 3");
    expect(ticketIdLine({ jti: JTI, index: 1, count: 3, holder: "  ", sep: " - " })).toBe("Ticket #b131e09c - 2 of 3");
  });

  it("leads with the runner", () => {
    expect(ticketIdLine({ jti: JTI, index: 0, count: 3, holder: "Ko Aung · M", sep: " · " }))
      .toBe("Ko Aung · M · #b131e09c · 1 of 3");
    expect(ticketIdLine({ jti: JTI, index: 0, count: 1, holder: "Ma Su", sep: " - " })).toBe("Ma Su - #b131e09c");
  });
});

describe("pdfHolder", () => {
  it("swaps the label's dot separator for the PDF's", () => {
    expect(pdfHolder("Ma Su · Kids 8")).toBe("Ma Su - Kids 8");
  });
  it("leaves off a name the standard PDF font can't draw", () => {
    expect(pdfHolder("မမ · M")).toBeNull();
  });
  it("keeps Latin-1 accents", () => {
    expect(pdfHolder("José · L")).toBe("José - L");
  });
  it("is null with no runner", () => {
    expect(pdfHolder(null)).toBeNull();
    expect(pdfHolder(" ")).toBeNull();
  });
});
