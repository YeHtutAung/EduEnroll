import { describe, it, expect } from "vitest";
import { priorityWindowReminderEmail } from "@/lib/email";

// ─── The reminder's copy must branch on whether the window is already open ───
//
// The invitation is explicitly permitted after the window opens — an organiser
// who schedules the window and then presses send is in that case as often as
// not. A template that unconditionally says "Opens Soon" and "this link will
// not work until X" therefore tells recipients their WORKING link is dead, at
// the exact moment they are being urged to use it.
//
// These tests assert the two variants say opposite things, not merely that
// they differ: a branch that produced two subtly different flavours of "not
// yet" would satisfy a difference check and still be wrong.

const BASE = {
  name: "Aung Aung",
  eventName: "Summer Fest",
  link: "https://acme.kuunyi.com/enroll/summer-fest#pa=tok",
  windowOpensAt: "September 1, 2026 at 10:00 AM MMT",
  coveredTiers: ["VIP"],
};

describe("priorityWindowReminderEmail", () => {
  it("says the window opens later when it has not opened yet", () => {
    const { subject, html } = priorityWindowReminderEmail({ ...BASE, windowIsOpen: false });

    expect(subject).toContain("Opens Soon");
    expect(html).toContain("Your Priority Window Opens Soon");
    expect(html).toContain(`This link will not work until ${BASE.windowOpensAt}`);
    expect(html).not.toContain("This link works right now");
  });

  it("says the link works now when the window has already opened", () => {
    const { subject, html } = priorityWindowReminderEmail({ ...BASE, windowIsOpen: true });

    expect(subject).toContain("Is Open");
    expect(subject).not.toContain("Opens Soon");
    expect(html).toContain("Your Priority Window Is Open");
    expect(html).toContain("This link works right now");

    // The claim that would be a lie. Its absence is the whole point.
    expect(html).not.toContain("This link will not work until");
    expect(html).not.toContain("Opens Soon");
  });

  it("defaults to the not-yet-open copy when the flag is omitted", () => {
    // Fail safe: a caller that forgets the flag under-promises rather than
    // telling someone a dead link is live.
    const { subject, html } = priorityWindowReminderEmail(BASE);

    expect(subject).toContain("Opens Soon");
    expect(html).toContain("This link will not work until");
  });

  it("carries the freshly minted link and the covered tiers in both variants", () => {
    for (const windowIsOpen of [true, false]) {
      const { html } = priorityWindowReminderEmail({ ...BASE, windowIsOpen });
      expect(html).toContain(BASE.link);
      expect(html).toContain("VIP");
      // Still supersedes the recipient's earlier link, open or not.
      expect(html).toContain("supersedes any link from your earlier confirmation email");
    }
  });
});
