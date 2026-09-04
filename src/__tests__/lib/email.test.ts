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
});
