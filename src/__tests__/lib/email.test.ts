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
});
