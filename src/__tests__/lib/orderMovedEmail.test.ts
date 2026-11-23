import { describe, expect, it } from "vitest";
import { orderMovedAwayEmail, orderMovedInEmail } from "@/lib/email";

describe("orderMovedAwayEmail", () => {
  it("names the order and the organiser, and says who to contact", () => {
    const { subject, html } = orderMovedAwayEmail({
      enrollmentRef: "SF2-1104-ABC123",
      tenantName: "Sky Festival",
    });

    expect(subject).toContain("SF2-1104-ABC123");
    expect(subject).toMatch(/moved to another account/i);
    expect(html).toContain("SF2-1104-ABC123");
    expect(html).toContain("was moved to another account by");
    expect(html).toContain("If you didn't ask for this, contact");
    expect(html.match(/Sky Festival/g)?.length).toBeGreaterThanOrEqual(2);
    // Myanmar line is present.
    expect(html).toMatch(/[က-႟]/);
  });

  it("escapes the organiser's name and the reference", () => {
    const { html } = orderMovedAwayEmail({
      enrollmentRef: "<b>REF</b>",
      tenantName: `<script>alert("x")</script> & Co`,
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>REF</b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co");
    expect(html).toContain("&lt;b&gt;REF&lt;/b&gt;");
  });

  it("carries no link", () => {
    const { html } = orderMovedAwayEmail({ enrollmentRef: "R-1", tenantName: "Org" });
    // Only the footer link to the platform.
    expect(html.match(/<a /g)?.length ?? 0).toBe(1);
  });
});

describe("orderMovedInEmail", () => {
  it("names the order and links to the tenant's ticket page", () => {
    const { subject, html } = orderMovedInEmail({
      enrollmentRef: "SF2-1104-ABC123",
      tenantName: "Sky Festival",
      myTicketsUrl: "https://skyfestival.kuunyi.com/account/tickets",
    });

    expect(subject).toContain("SF2-1104-ABC123");
    expect(subject).toMatch(/added to your account/i);
    expect(html).toContain("SF2-1104-ABC123");
    expect(html).toContain("was added to your account");
    expect(html).toContain('href="https://skyfestival.kuunyi.com/account/tickets"');
    expect(html).toContain("skyfestival.kuunyi.com");
    expect(html).toContain("Sky Festival");
    expect(html).toMatch(/[က-႟]/);
  });

  it("escapes the organiser's name, the reference and the link", () => {
    const { html } = orderMovedInEmail({
      enrollmentRef: "<i>R</i>",
      tenantName: "A&B <Org>",
      myTicketsUrl: `https://x.kuunyi.com/account/tickets?a="b"`,
    });

    expect(html).not.toContain("<i>R</i>");
    expect(html).toContain("&lt;i&gt;R&lt;/i&gt;");
    expect(html).toContain("A&amp;B &lt;Org&gt;");
    expect(html).not.toContain('a="b"');
  });
});
