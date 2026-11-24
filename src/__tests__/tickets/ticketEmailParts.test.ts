import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 15 (design 8.1): the one helper every confirmation email asks. Tickets
// on an account-bound (protected) event never reach the PDF; the email says
// "Open My Tickets" instead, and that answer survives a PDF failure.

const { mockAdmin, toDataURLSpy, signSpy } = vi.hoisted(() => ({
  mockAdmin: { from: vi.fn() },
  toDataURLSpy: vi.fn(),
  signSpy: vi.fn(({ jti }: { jti: string }) => `signed-ticket-token-${jti}`),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockAdmin }));
vi.mock("@/lib/tickets/sign", () => ({ signTicketJwt: signSpy }));
vi.mock("qrcode", async (importOriginal) => {
  const actual = (await importOriginal()) as {
    default: { toDataURL: (...args: unknown[]) => Promise<string> };
  };
  toDataURLSpy.mockImplementation((...args: unknown[]) => actual.default.toDataURL(...args));
  return { default: { ...actual.default, toDataURL: toDataURLSpy } };
});

const { buildTicketEmailParts } = await import("@/server/tickets/eticketEmailAttachment");

const OPEN = "e063be0c-1234-4000-8000-000000000001";
const BOUND = "e063be0c-1234-4000-8000-000000000002";

function query(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
}

function ticketRow(id: string, intakeId: string, seat: number) {
  return {
    id,
    intake_id: intakeId,
    tier: "General Access - GA",
    admits: 1,
    exp: "2026-12-01T00:00:00.000Z",
    class_id: "class-1",
    seat_no: seat,
  };
}

function mockQueries(tickets: unknown[], intakes: unknown) {
  const intakesQuery = query(intakes);
  mockAdmin.from.mockImplementation((table: string) => {
    if (table === "enrollments") return query({ data: { enrollment_ref: "SF2-1123-AAAAAA" }, error: null });
    if (table === "tickets") return query({ data: tickets, error: null });
    return intakesQuery;
  });
  return { intakesQuery };
}

const openIntake = { id: "intake-open", name: "Open Night", ticket_qr_format: "jwt", ticket_protection: false };
const boundIntake = { id: "intake-bound", name: "Bound Night", ticket_qr_format: "jwt", ticket_protection: true };

function pageCount(base64: string): number {
  return (Buffer.from(base64, "base64").toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
}

beforeEach(() => {
  mockAdmin.from.mockReset();
  toDataURLSpy.mockClear();
  signSpy.mockClear();
});

describe("buildTicketEmailParts", () => {
  it("an order whose tickets are all protected gets no PDF and the account answer", async () => {
    mockQueries([ticketRow(BOUND, "intake-bound", 1)], { data: [boundIntake], error: null });

    await expect(buildTicketEmailParts("enrollment-1")).resolves.toEqual({
      attachment: null,
      accountTickets: true,
    });
    // Nothing is signed or encoded for a protected ticket.
    expect(signSpy).not.toHaveBeenCalled();
    expect(toDataURLSpy).not.toHaveBeenCalled();
  });

  it("a mixed cart gets a PDF of only the unprotected tickets, with accountTickets", async () => {
    const { intakesQuery } = mockQueries(
      [ticketRow(OPEN, "intake-open", 1), ticketRow(BOUND, "intake-bound", 2)],
      { data: [openIntake, boundIntake], error: null },
    );

    const parts = await buildTicketEmailParts("enrollment-1");

    expect(parts.accountTickets).toBe(true);
    expect(parts.attachment?.filename).toBe("eticket-SF2-1123-AAAAAA.pdf");
    expect(pageCount(parts.attachment!.content)).toBe(1);
    expect(toDataURLSpy.mock.calls.map((c) => c[0])).toEqual([`signed-ticket-token-${OPEN}`]);
    expect(signSpy.mock.calls.map((c) => c[0].jti)).toEqual([OPEN]);
    expect(intakesQuery.select).toHaveBeenCalledWith(expect.stringContaining("ticket_protection"));
  });

  it("an unprotected order gets the same PDF as today, with accountTickets false", async () => {
    mockQueries(
      [ticketRow(OPEN, "intake-open", 1), ticketRow(BOUND, "intake-open", 2)],
      { data: [openIntake], error: null },
    );

    const parts = await buildTicketEmailParts("enrollment-1");

    expect(parts.accountTickets).toBe(false);
    expect(pageCount(parts.attachment!.content)).toBe(2);
    expect(toDataURLSpy.mock.calls.map((c) => c[0])).toEqual([
      `signed-ticket-token-${OPEN}`,
      `signed-ticket-token-${BOUND}`,
    ]);
  });

  it("an order with no valid tickets gets nothing, without reading events", async () => {
    mockQueries([], { data: [], error: null });

    await expect(buildTicketEmailParts("enrollment-1")).resolves.toEqual({
      attachment: null,
      accountTickets: false,
    });
    expect(mockAdmin.from).not.toHaveBeenCalledWith("intakes");
  });

  it("a PDF render failure keeps the account answer", async () => {
    mockQueries(
      [ticketRow(OPEN, "intake-open", 1), ticketRow(BOUND, "intake-bound", 2)],
      { data: [openIntake, boundIntake], error: null },
    );
    toDataURLSpy.mockRejectedValueOnce(new Error("canvas exploded"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(buildTicketEmailParts("enrollment-1")).resolves.toEqual({
      attachment: null,
      accountTickets: true,
    });
    spy.mockRestore();
  });

  it("an unreadable QR format on the unprotected part keeps the account answer", async () => {
    mockQueries(
      [ticketRow(OPEN, "intake-open", 1), ticketRow(BOUND, "intake-bound", 2)],
      { data: [{ ...openIntake, ticket_qr_format: null }, boundIntake], error: null },
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(buildTicketEmailParts("enrollment-1")).resolves.toEqual({
      attachment: null,
      accountTickets: true,
    });
    expect(toDataURLSpy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("throws when the events can't be read, so callers fall back to no PDF and no button", async () => {
    mockQueries([ticketRow(BOUND, "intake-bound", 1)], { data: null, error: { code: "XX000" } });
    await expect(buildTicketEmailParts("enrollment-1")).rejects.toThrow(/event details/);
    expect(toDataURLSpy).not.toHaveBeenCalled();
  });

  it("throws when a ticket's event is missing from the lookup (protection unknown)", async () => {
    mockQueries([ticketRow(BOUND, "intake-bound", 1)], { data: [], error: null });
    await expect(buildTicketEmailParts("enrollment-1")).rejects.toThrow();
    expect(toDataURLSpy).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
  });
});
