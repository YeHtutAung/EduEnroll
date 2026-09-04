import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tickets/sign", () => ({ signTicketJwt: () => "signed-ticket-token" }));

const { renderEticketPdf } = await import("@/server/tickets/eticketEmailAttachment");

describe("renderEticketPdf", () => {
  it("creates a PDF containing every issued ticket", async () => {
    const content = await renderEticketPdf("LM-0904-FY6A", [
      {
        id: "e063be0c-1234-4000-8000-000000000001",
        intake_id: "intake-1",
        tier: "General Access - GA",
        admits: 1,
        exp: "2026-10-01T00:00:00.000Z",
        eventName: "October 2026 Event",
      },
    ]);

    const pdf = Buffer.from(content, "base64");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1_000);
  });
});
