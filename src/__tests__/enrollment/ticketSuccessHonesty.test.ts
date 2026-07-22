import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../../app/(public)/enroll/[slug]/checkout/success/page.tsx", import.meta.url)),
  "utf8",
);

describe("ticket success page truthfulness", () => {
  it("does not claim an email or ticket exists before a ticket row exists", () => {
    expect(source).not.toContain("E-tickets sent to your email");
    expect(source).not.toContain("{/* QR placeholder */}");
    expect(source).toContain("Your e-ticket is ready below");
    expect(source).toContain("TICKET PENDING");
  });

  it("shows rejected payments as support cases and exposes PDF only for real tickets", () => {
    expect(source).toContain('const paymentNeedsAttention = data.status === "rejected"');
    expect(source).toContain("No ticket was issued. Contact support");
    expect(source).toContain("{ticketReady && (");
  });
});
