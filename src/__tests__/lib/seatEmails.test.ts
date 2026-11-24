import { describe, expect, it } from "vitest";
import { seatClaimedEmail, seatGivenBackEmail } from "@/lib/email";

describe("seatClaimedEmail", () => {
  it("names the tier in the subject and the masked claimer in the body", () => {
    const { subject, html } = seatClaimedEmail({
      tier: "VIP",
      claimedBy: "k***@gmail.com",
      tenantName: "Sky Festival",
    });
    expect(subject).toBe("Your VIP seat was claimed");
    expect(html).toContain("k***@gmail.com");
    expect(html).toContain("Only their phone can show its QR now.");
    expect(html).toMatch(/[က-႟]/);
  });

  it("escapes the tier, the organiser and the masked email", () => {
    const { html } = seatClaimedEmail({
      tier: "<b>VIP</b>",
      claimedBy: "<i>k</i>***@gmail.com",
      tenantName: "<b>Org</b>",
    });
    expect(html).not.toContain("<b>VIP</b>");
    expect(html).not.toContain("<b>Org</b>");
    expect(html).not.toContain("<i>k</i>");
    expect(html).toContain("&lt;b&gt;VIP&lt;/b&gt;");
    expect(html).toContain("&lt;b&gt;Org&lt;/b&gt;");
  });

  it("has no @ except in the masked email", () => {
    const { html } = seatClaimedEmail({ tier: "VIP", claimedBy: "k***@gmail.com", tenantName: "Org" });
    expect(html.replaceAll("k***@gmail.com", "").includes("@")).toBe(false);
  });
});

describe("seatGivenBackEmail", () => {
  it("names the tier in the subject and tells the leader to open My Tickets", () => {
    const { subject, html } = seatGivenBackEmail({ tier: "VIP", tenantName: "Sky Festival" });
    expect(subject).toBe("A VIP seat was given back to you");
    expect(html).toContain("A seat you shared was given back to you.");
    expect(html).toContain("My Tickets");
    expect(html).toMatch(/[က-႟]/);
  });

  it("escapes the tier and the organiser, and contains no @", () => {
    const { html } = seatGivenBackEmail({ tier: "<b>VIP</b>", tenantName: "<b>Org</b>" });
    expect(html).not.toContain("<b>VIP</b>");
    expect(html).not.toContain("<b>Org</b>");
    expect(html).toContain("&lt;b&gt;VIP&lt;/b&gt;");
    expect(html.includes("@")).toBe(false);
  });
});
