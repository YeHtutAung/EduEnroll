import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdmin, toDataURLSpy } = vi.hoisted(() => ({
  mockAdmin: { from: vi.fn() },
  toDataURLSpy: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockAdmin }));
vi.mock("@/lib/tickets/sign", () => ({
  signTicketJwt: ({ jti }: { jti: string }) => `signed-ticket-token-${jti}`,
}));
// Real QR rendering, observed: the PDFs below must still be real PDFs.
vi.mock("qrcode", async (importOriginal) => {
  const actual = (await importOriginal()) as {
    default: { toDataURL: (...args: unknown[]) => Promise<string> };
  };
  toDataURLSpy.mockImplementation((...args: unknown[]) => actual.default.toDataURL(...args));
  return { default: { ...actual.default, toDataURL: toDataURLSpy } };
});

const { buildEticketEmailAttachment, renderEticketPdf } =
  await import("@/server/tickets/eticketEmailAttachment");

const ticket = (number: number, qrFormat: "jwt" | "uuid" = "jwt") => ({
  id: `e063be0c-1234-4000-8000-${String(number).padStart(12, "0")}`,
  intake_id: "intake-1",
  tier: "General Access - GA",
  admits: 1,
  exp: "2026-10-01T00:00:00.000Z",
  eventName: "October 2026 Event",
  qrFormat,
});

const encodedTexts = () => toDataURLSpy.mock.calls.map((call) => call[0]);

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
  toDataURLSpy.mockClear();
});

function mockAttachmentQueries(intakes: unknown) {
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
  const intakesQuery = query(intakes);
  mockAdmin.from.mockImplementation((table: string) => {
    if (table === "enrollments") return enrollmentQuery;
    if (table === "tickets") return ticketsQuery;
    return intakesQuery;
  });
  return { ticketsQuery, intakesQuery };
}

describe("e-ticket QR payload", () => {
  it("encodes the signed token for a jwt event and the bare UUID for a uuid event", async () => {
    await renderEticketPdf("LM-0904-FY6A", [ticket(1, "jwt"), ticket(2, "uuid")]);

    expect(encodedTexts()).toEqual([
      "signed-ticket-token-e063be0c-1234-4000-8000-000000000001",
      "e063be0c-1234-4000-8000-000000000002",
    ]);
  });

  it("keeps the QR at 240px with a 1-module margin in both formats", async () => {
    await renderEticketPdf("LM-0904-FY6A", [ticket(1, "uuid")]);
    // objectContaining: qrcode writes defaults (e.g. `color`) into the options
    // object it is handed, and the spy records that same object.
    expect(toDataURLSpy).toHaveBeenCalledWith(
      "e063be0c-1234-4000-8000-000000000001",
      expect.objectContaining({ width: 240, margin: 1 }),
    );
  });

  it("reads each event's format when building the attachment", async () => {
    mockAttachmentQueries({
      data: [{ id: "intake-1", name: "October 2026 Event", ticket_qr_format: "uuid" }],
      error: null,
    });

    await buildEticketEmailAttachment("enrollment-1");

    expect(encodedTexts()).toEqual(["e063be0c-1234-4000-8000-000000000001"]);
  });

  it("refuses to build an attachment when an event's format is unknown", async () => {
    mockAttachmentQueries({
      data: [{ id: "intake-1", name: "October 2026 Event", ticket_qr_format: null }],
      error: null,
    });

    await expect(buildEticketEmailAttachment("enrollment-1")).rejects.toThrow(
      /unknown ticket QR format/,
    );
    expect(toDataURLSpy).not.toHaveBeenCalled();
  });

  it("refuses to build an attachment when a ticket's event is missing from the lookup", async () => {
    mockAttachmentQueries({ data: [], error: null });

    await expect(buildEticketEmailAttachment("enrollment-1")).rejects.toThrow(
      /unknown ticket QR format/,
    );
  });
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
      data: [{ id: "intake-1", name: "October 2026 Event", ticket_qr_format: "jwt" }],
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
