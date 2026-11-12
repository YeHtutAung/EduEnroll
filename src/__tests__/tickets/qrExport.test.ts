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

type Order = NonNullable<QrExportTicket["enrollments"]>;

function order(over: Partial<Order> = {}): Order {
  return {
    enrollment_ref: "SF2-1105-AAAAAA",
    status: "confirmed",
    internal_test_at: null,
    student_name_en: "Aung Aung",
    phone: "09123456789",
    email: "buyer@example.com",
    ...over,
  };
}

function ticket(over: Partial<QrExportTicket> = {}): QrExportTicket {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    intake_id: "22222222-2222-2222-2222-222222222222",
    tier: "GA",
    admits: 1,
    seat_no: 1,
    exp: "2026-11-24T17:29:59+00:00",
    enrollments: order(),
    ...over,
  };
}

const BOM = "﻿";

describe("admissibleTickets", () => {
  it("keeps only confirmed, non-test orders and sorts by ref then seat", () => {
    const rows = [
      ticket({ id: "b2", seat_no: 2, enrollments: order({ enrollment_ref: "B" }) }),
      ticket({ id: "pending", enrollments: order({ enrollment_ref: "C", status: "pending_payment" }) }),
      ticket({ id: "test", enrollments: order({ enrollment_ref: "D", internal_test_at: "2026-11-06T00:00:00Z" }) }),
      ticket({ id: "orphan", enrollments: null }),
      ticket({ id: "b1", seat_no: 1, enrollments: order({ enrollment_ref: "B" }) }),
      ticket({ id: "a1", enrollments: order({ enrollment_ref: "A" }) }),
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
  it("writes a BOM, a header and one CRLF row per ticket with the buyer's details", () => {
    const csv = qrExportCsv("uuid", [ticket({ tier: 'VIP, "Gold"' })]);
    expect(csv).toBe(
      BOM +
        QR_EXPORT_HEADER +
        "\r\n" +
        "SF2-1105-AAAAAA,Aung Aung,09123456789,buyer@example.com," +
        '11111111-1111-1111-1111-111111111111,"VIP, ""Gold""",1,1,2026-11-24T17:29:59.000Z,' +
        "11111111-1111-1111-1111-111111111111\r\n",
    );
  });

  it("writes empty cells for missing contact details", () => {
    const csv = qrExportCsv("uuid", [ticket({ enrollments: order({ student_name_en: null, phone: null, email: null }) })]);
    expect(csv.split("\r\n")[1].startsWith("SF2-1105-AAAAAA,,,,")).toBe(true);
  });

  it("keeps Burmese names intact", () => {
    const csv = qrExportCsv("uuid", [ticket({ enrollments: order({ student_name_en: "အောင်အောင်" }) })]);
    expect(csv.split("\r\n")[1].split(",")[1]).toBe("အောင်အောင်");
  });

  it("stops a spreadsheet treating buyer-typed values as formulas", () => {
    const csv = qrExportCsv("uuid", [
      ticket({ enrollments: order({ student_name_en: "=HYPERLINK(1)", phone: "+959123456789", email: "@x" }) }),
    ]);
    const cells = csv.split("\r\n")[1].split(",");
    expect(cells.slice(1, 4)).toEqual(["'=HYPERLINK(1)", "'+959123456789", "'@x"]);
  });
});
