// ─── Ticket QR export (CSV) ──────────────────────────────────────────────────
//
// Builds a CSV of an event's admissible tickets with the exact text each
// ticket's QR encodes, plus the buyer's name, phone and email. Used by
// scripts/export-ticket-qr.ts.
//
// The QR text is produced the same way the order page and the e-ticket email
// produce it: ticketQrPayload() over signTicketJwt() with the same claims. Ed25519
// signatures are deterministic, so with the same signing key a 'jwt' event's
// rows match the QRs buyers already hold byte for byte.

import { signTicketJwt } from "@/lib/tickets/sign";
import { ticketQrPayload, type TicketQrFormat } from "@/lib/tickets/qrPayload";

export type QrExportTicket = {
  id: string;
  intake_id: string;
  tier: string;
  admits: number;
  seat_no: number;
  exp: string;
  enrollments: {
    enrollment_ref: string;
    status: string;
    internal_test_at: string | null;
    student_name_en: string | null;
    phone: string | null;
    email: string | null;
  } | null;
};

/** Valid tickets on confirmed, non-test orders, by order ref then seat. */
export function admissibleTickets(rows: QrExportTicket[]): QrExportTicket[] {
  return rows
    .filter((t) => t.enrollments?.status === "confirmed" && t.enrollments.internal_test_at === null)
    .sort(
      (a, b) =>
        a.enrollments!.enrollment_ref.localeCompare(b.enrollments!.enrollment_ref) || a.seat_no - b.seat_no,
    );
}

/** The text encoded in this ticket's QR, as the order page and email build it. */
export function ticketQrText(format: TicketQrFormat, t: QrExportTicket): string {
  return ticketQrPayload(format, t.id, () =>
    signTicketJwt({
      jti: t.id,
      eid: t.intake_id,
      tier: t.tier,
      admits: t.admits,
      exp: Math.floor(Date.parse(t.exp) / 1000),
    }),
  );
}

export const QR_EXPORT_HEADER =
  "ticket_ref,customer_name,phone,email,ticket_id,tier,admits,seat_no,expires_at,qr_text";

// Excel opens a BOM-less UTF-8 CSV in the local code page, which garbles
// Burmese names. The BOM makes it read the file as UTF-8.
const UTF8_BOM = "\uFEFF";

export function qrExportCsv(format: TicketQrFormat, tickets: QrExportTicket[]): string {
  const lines = tickets.map((t) => {
    const e = t.enrollments!;
    return [
      csvField(e.enrollment_ref),
      csvField(asText(e.student_name_en ?? "")),
      csvField(asText(e.phone ?? "")),
      csvField(asText(e.email ?? "")),
      csvField(t.id),
      csvField(t.tier),
      csvField(String(t.admits)),
      csvField(String(t.seat_no)),
      csvField(new Date(t.exp).toISOString()),
      csvField(ticketQrText(format, t)),
    ].join(",");
  });
  return UTF8_BOM + [QR_EXPORT_HEADER, ...lines].join("\r\n") + "\r\n";
}

/**
 * Buyer-typed values are untrusted. A spreadsheet runs a cell that starts with
 * = + - @ (or a tab / CR) as a formula, and turns "+959…" into a number. A
 * leading apostrophe makes the cell plain text.
 */
function asText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
