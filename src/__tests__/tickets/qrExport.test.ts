import { it, expect, beforeAll, describe } from "vitest";
import { generateKeyPairSync } from "crypto";
import { signTicketJwt, verifyTicketJwt } from "@/lib/tickets/sign";
import {
  admissibleTickets,
  qrExportCsv,
  ticketQrText,
  QR_EXPORT_HEADER,
  type QrExportTicket,
} from "@/server/tickets/qrExport";

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
});

function ticket(over: Partial<QrExportTicket> = {}): QrExportTicket {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    intake_id: "22222222-2222-2222-2222-222222222222",
    tier: "GA",
    admits: 1,
    seat_no: 1,
    exp: "2026-11-24T17:29:59+00:00",
    enrollments: { enrollment_ref: "SF2-1105-AAAAAA", status: "confirmed", internal_test_at: null },
    ...over,
  };
}

describe("admissibleTickets", () => {
  it("keeps only confirmed, non-test orders and sorts by ref then seat", () => {
    const rows = [
      ticket({ id: "b2", seat_no: 2, enrollments: { enrollment_ref: "B", status: "confirmed", internal_test_at: null } }),
      ticket({ id: "pending", enrollments: { enrollment_ref: "C", status: "pending_payment", internal_test_at: null } }),
      ticket({ id: "test", enrollments: { enrollment_ref: "D", status: "confirmed", internal_test_at: "2026-11-06T00:00:00Z" } }),
      ticket({ id: "orphan", enrollments: null }),
      ticket({ id: "b1", seat_no: 1, enrollments: { enrollment_ref: "B", status: "confirmed", internal_test_at: null } }),
      ticket({ id: "a1", enrollments: { enrollment_ref: "A", status: "confirmed", internal_test_at: null } }),
    ];
    expect(admissibleTickets(rows).map((t) => t.id)).toEqual(["a1", "b1", "b2"]);
  });
});

describe("ticketQrText", () => {
  it("is the bare ticket id on a uuid event", () => {
    expect(ticketQrText("uuid", ticket())).toBe(ticket().id);
  });

  it("is the same signed token the order page builds on a jwt event", () => {
    const t = ticket({ tier: "All Day", admits: 2 });
    const asOrderPage = signTicketJwt({
      jti: t.id,
      eid: t.intake_id,
      tier: t.tier,
      admits: t.admits,
      exp: Math.floor(Date.parse(t.exp) / 1000),
    });
    const text = ticketQrText("jwt", t);
    expect(text).toBe(asOrderPage);
    expect(verifyTicketJwt(text)).toEqual({
      jti: t.id,
      eid: t.intake_id,
      tier: "All Day",
      admits: 2,
      exp: Math.floor(Date.parse(t.exp) / 1000),
    });
  });
});

describe("qrExportCsv", () => {
  it("writes a header and one CRLF row per ticket, quoting fields that need it", () => {
    const csv = qrExportCsv("uuid", [ticket({ tier: 'VIP, "Gold"' })]);
    expect(csv).toBe(
      QR_EXPORT_HEADER +
        "\r\n" +
        'SF2-1105-AAAAAA,11111111-1111-1111-1111-111111111111,"VIP, ""Gold""",1,1,2026-11-24T17:29:59.000Z,11111111-1111-1111-1111-111111111111\r\n',
    );
  });
});
