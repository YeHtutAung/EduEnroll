import { describe, expect, it } from "vitest";
import { enrollmentApprovedEmail } from "@/lib/email";
import { accountTicketsUrl } from "@/server/tickets/eticketEmailAttachment";

// Task 15 (design 6.3, 8.1): the approval email of an order with account-bound
// tickets carries an "Open My Tickets" button on the tenant's host instead of a
// QR. Without `myTicketsUrl` the email is exactly as before.

const base = {
  studentName: "Aung Aung",
  enrollmentRef: "SF2-1123-AAAAAA",
  classLevel: "GA x2",
  statusUrl: "https://skyfestival.kuunyi.com/status?ref=SF2-1123-AAAAAA",
  orgType: "event",
  tenantName: "Sky Festival",
};

describe("enrollmentApprovedEmail — myTicketsUrl", () => {
  it("renders the button and the two lines when set", () => {
    const { html } = enrollmentApprovedEmail({
      ...base,
      myTicketsUrl: "https://skyfestival.kuunyi.com/account/tickets",
    });
    expect(html).toContain('href="https://skyfestival.kuunyi.com/account/tickets"');
    expect(html).toContain("Open My Tickets");
    expect(html).toContain("Your ticket is on your account. Sign in on this site to open it.");
    expect(html).toContain(
      "Open it again on your phone before the event day, and keep the page open at the gate.",
    );
    // The Myanmar button text sits next to the English one.
    expect(html).toMatch(/Open My Tickets[\s\S]*font-myanmar|Noto Sans Myanmar/);
  });

  it("says a seat can be shared until 24 hours before the event, in both languages", () => {
    const { html } = enrollmentApprovedEmail({
      ...base,
      myTicketsUrl: "https://skyfestival.kuunyi.com/account/tickets",
    });
    expect(html).toContain(
      "You can share a seat with a friend from My Tickets until 24 hours before the event.",
    );
    // The Myanmar paragraph follows the "Open it again" one (NEEDS NATIVE REVIEW).
    const afterOpen = html.slice(html.indexOf("keep the page open at the gate."));
    expect(afterOpen).toMatch(/class="myanmar"[^>]*>[^<]*[က-႟]+[^<]*<\/p>[\s\S]*share a seat/);
    expect(afterOpen).toMatch(/share a seat[\s\S]*class="myanmar"[^>]*>[^<]*[က-႟]/);
  });

  it("escapes the link", () => {
    const { html } = enrollmentApprovedEmail({ ...base, myTicketsUrl: 'https://x.test/account/tickets?a="b' });
    expect(html).toContain('href="https://x.test/account/tickets?a=&quot;b"');
  });

  it("without it, the email has no account link and is unchanged", () => {
    const without = enrollmentApprovedEmail(base);
    expect(without.html).not.toContain("/account/tickets");
    expect(without.html).not.toContain("Open My Tickets");
    expect(without.html).not.toContain("share a seat");
    expect(enrollmentApprovedEmail({ ...base, myTicketsUrl: undefined })).toEqual(without);
  });
});

describe("accountTicketsUrl", () => {
  it("keeps the tenant host of the status link and drops its path and query", () => {
    expect(accountTicketsUrl("https://skyfestival.kuunyi.com/status?ref=SF2-1")).toBe(
      "https://skyfestival.kuunyi.com/account/tickets",
    );
    expect(accountTicketsUrl("https://skyfestivalmm.com")).toBe("https://skyfestivalmm.com/account/tickets");
  });
});
