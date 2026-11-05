import { describe, expect, it } from "vitest";
import { enrollmentApprovedEmail } from "@/lib/email";

describe("enrollmentApprovedEmail", () => {
  it("centers the confirmation icon without flexbox", () => {
    const { html } = enrollmentApprovedEmail({
      studentName: "Yehtut Aung",
      enrollmentRef: "LM-0904-FY6A",
      classLevel: "General Access - GA",
      statusUrl: "https://brave.kuunyi.com/status?ref=LM-0904-FY6A",
      orgType: "event",
    });

    expect(html).toContain("text-align: center; line-height: 56px;");
    expect(html).toContain('<span style="font-size: 28px; line-height: 56px;">🎉</span>');
    expect(html).not.toContain("align-items: center; justify-content: center;");
  });

  it("shows the settled ticket, platform-fee, and total-paid rows", () => {
    const { html } = enrollmentApprovedEmail({
      studentName: "Yehtut Aung",
      enrollmentRef: "LM-0904-8VEN",
      classLevel: "General Access - GA x2",
      statusUrl: "https://brave.kuunyi.com/status?ref=LM-0904-8VEN",
      orgType: "event",
      ticketCount: 2,
      ticketSubtotalFormatted: "2,000 MMK",
      platformFeeFormatted: "2,000 MMK",
      totalPaidFormatted: "4,000 MMK",
    });

    expect(html).toContain("Tickets (2)");
    expect(html).toContain("Online platform fee");
    expect(html).toContain("Total paid");
    expect(html).toContain("2,000 MMK");
    expect(html).toContain("4,000 MMK");
    expect(html).toContain("လက်မှတ်များ");
    expect(html).toContain("အွန်လိုင်း ဝန်ဆောင်ခ");
    expect(html).toContain("စုစုပေါင်း ပေးချေငွေ");
  });

  it("makes a zero platform fee explicit", () => {
    const { html } = enrollmentApprovedEmail({
      studentName: "Yehtut Aung",
      enrollmentRef: "LM-0904-FREE",
      classLevel: "General Access - GA",
      statusUrl: "https://brave.kuunyi.com/status?ref=LM-0904-FREE",
      orgType: "event",
      ticketCount: 1,
      ticketSubtotalFormatted: "1,000 MMK",
      platformFeeFormatted: "No fee",
      totalPaidFormatted: "1,000 MMK",
    });

    expect(html).toContain("Online platform fee");
    expect(html).toContain("No fee");
  });

  describe("event images", () => {
    const base = {
      studentName: "Buyer",
      enrollmentRef: "SF2-1105-IMG",
      classLevel: "Day 1",
      statusUrl: "https://skyfestival.kuunyi.com/status?ref=SF2-1105-IMG",
      orgType: "event",
    };
    const image = { url: "https://cdn.example.com/day-1.jpg", alt: "Day 1" };

    it("prints each poster at full width, between the button and the terms", () => {
      const { html } = enrollmentApprovedEmail({
        ...base,
        eventTerms: "Non-Refundable.",
        eventImages: [image, { url: "https://cdn.example.com/day-2.jpg", alt: "Day 2" }],
      });

      expect(html).toContain('src="https://cdn.example.com/day-1.jpg"');
      expect(html).toContain('src="https://cdn.example.com/day-2.jpg"');
      expect(html).toContain('alt="Day 1"');
      expect(html).toContain("width: 100%");
      expect(html.indexOf("Details</a>")).toBeLessThan(html.indexOf("day-1.jpg"));
      expect(html.indexOf("day-1.jpg")).toBeLessThan(html.indexOf("day-2.jpg"));
      expect(html.indexOf("day-2.jpg")).toBeLessThan(html.indexOf("Non-Refundable."));
    });

    it("escapes the tier name and the address", () => {
      const { html } = enrollmentApprovedEmail({
        ...base,
        eventImages: [
          { url: 'https://cdn.example.com/a.jpg?x="><script>', alt: '"><script>alert(1)</script>' },
        ],
      });
      expect(html).not.toContain("<script>");
    });

    it("refuses an address that is not https", () => {
      const { html } = enrollmentApprovedEmail({
        ...base,
        eventImages: [{ url: "javascript:alert(1)", alt: "Day 1" }],
      });
      expect(html).not.toContain("javascript:");
    });

    // Other clients have no images: their email must not change at all.
    it.each([[undefined], [null], [[]]])("leaves the email exactly as it was for %j", (eventImages) => {
      const before = enrollmentApprovedEmail(base).html;
      expect(enrollmentApprovedEmail({ ...base, eventImages }).html).toBe(before);
    });
  });

  describe("event terms", () => {
    const base = {
      studentName: "Buyer",
      enrollmentRef: "SF2-1105-TERMS",
      classLevel: "General Access",
      statusUrl: "https://skyfestival.kuunyi.com/status?ref=SF2-1105-TERMS",
      orgType: "event",
    };

    it("prints the terms with their line breaks", () => {
      const { html } = enrollmentApprovedEmail({
        ...base,
        eventTerms: "SKY FESTIVAL 2026\n\nNon-Refundable: All ticket purchases are final.",
      });

      expect(html).toContain(
        "SKY FESTIVAL 2026<br /><br />Non-Refundable: All ticket purchases are final.",
      );
    });

    it("escapes what the organiser typed", () => {
      const { html } = enrollmentApprovedEmail({
        ...base,
        eventTerms: `TERMS & CONDITIONS <img src=x onerror="alert(1)">`,
      });

      expect(html).toContain("TERMS &amp; CONDITIONS &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
      expect(html).not.toContain("<img src=x");
    });

    it.each([undefined, null, "", "   \n "])("adds no box for %j", (eventTerms) => {
      const withTerms = enrollmentApprovedEmail(base).html;
      expect(enrollmentApprovedEmail({ ...base, eventTerms }).html).toBe(withTerms);
    });
  });
});
