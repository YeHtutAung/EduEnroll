import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { from: vi.fn() } }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockAdmin }));
vi.mock("@/lib/tickets/sign", () => ({
  signTicketJwt: ({ jti }: { jti: string }) => `signed-ticket-token-${jti}`,
}));

const { buildEticketEmailAttachment, renderEticketPdf } =
  await import("@/server/tickets/eticketEmailAttachment");

const ticket = (number: number) => ({
  id: `e063be0c-1234-4000-8000-${String(number).padStart(12, "0")}`,
  intake_id: "intake-1",
  tier: "General Access - GA",
  admits: 1,
  exp: "2026-10-01T00:00:00.000Z",
  eventName: "October 2026 Event",
});

function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
}

function query(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
}

beforeEach(() => {
  mockAdmin.from.mockReset();
});

describe("renderEticketPdf", () => {
  it("creates a page for every issued ticket and keeps the QR attachment compact", async () => {
    const oneTicket = Buffer.from(await renderEticketPdf("LM-0904-FY6A", [ticket(1)]), "base64");
    const sevenTickets = Buffer.from(
      await renderEticketPdf(
        "LM-0904-FY6A",
        Array.from({ length: 7 }, (_, index) => ticket(index + 1)),
      ),
      "base64",
    );

    expect(oneTicket.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(sevenTickets)).toBe(7);
    expect(oneTicket.length).toBeLessThan(300_000);
    expect(sevenTickets.length).toBeLessThan(2_000_000);
  });

  it("returns null without querying event details when an enrollment has no valid tickets", async () => {
    const enrollmentQuery = query({ data: { enrollment_ref: "LM-0904-FY6A" }, error: null });
    const ticketsQuery = query({ data: [], error: null });
    mockAdmin.from.mockImplementation((table: string) =>
      table === "enrollments" ? enrollmentQuery : ticketsQuery,
    );

    await expect(buildEticketEmailAttachment("enrollment-1")).resolves.toBeNull();
    expect(mockAdmin.from).toHaveBeenCalledWith("enrollments");
    expect(mockAdmin.from).toHaveBeenCalledWith("tickets");
    expect(mockAdmin.from).not.toHaveBeenCalledWith("intakes");
  });

  it("loads the issued tickets and event details before making the attachment", async () => {
    const enrollmentQuery = query({ data: { enrollment_ref: "LM-0904-FY6A" }, error: null });
    const ticketsQuery = query({
      data: [
        {
          id: "e063be0c-1234-4000-8000-000000000001",
          intake_id: "intake-1",
          tier: "General Access - GA",
          admits: 1,
          exp: "2026-10-01T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const intakesQuery = query({
      data: [{ id: "intake-1", name: "October 2026 Event" }],
      error: null,
    });
    mockAdmin.from.mockImplementation((table: string) => {
      if (table === "enrollments") return enrollmentQuery;
      if (table === "tickets") return ticketsQuery;
      return intakesQuery;
    });

    const attachment = await buildEticketEmailAttachment("enrollment-1");

    expect(mockAdmin.from).toHaveBeenNthCalledWith(1, "enrollments");
    expect(mockAdmin.from).toHaveBeenNthCalledWith(2, "tickets");
    expect(mockAdmin.from).toHaveBeenNthCalledWith(3, "intakes");
    expect(ticketsQuery.eq).toHaveBeenNthCalledWith(1, "enrollment_id", "enrollment-1");
    expect(ticketsQuery.eq).toHaveBeenNthCalledWith(2, "status", "valid");
    expect(intakesQuery.in).toHaveBeenCalledWith("id", ["intake-1"]);
    expect(attachment?.filename).toBe("eticket-LM-0904-FY6A.pdf");
    expect(Buffer.from(attachment!.content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });
});
