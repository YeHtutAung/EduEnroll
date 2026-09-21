// ─── What an e-ticket QR encodes ────────────────────────────────────────────
//
// Chosen per event (intakes.ticket_qr_format):
//
//   jwt  — the signed Ed25519 token, verified offline by the kuunyi-scanner app
//          and single-use-checked through POST /api/scans. The default.
//   uuid — the bare ticket id (tickets.id). For an event scanned by a third
//          party who receives a ticket list after the sale and checks entries
//          against their own database.
//
// Only the QR changes. The signed token is still produced and returned, so a
// uuid event loses nothing on our side.

export const TICKET_QR_FORMATS = ["jwt", "uuid"] as const;
export type TicketQrFormat = (typeof TICKET_QR_FORMATS)[number];

export function isTicketQrFormat(value: unknown): value is TicketQrFormat {
  return (TICKET_QR_FORMATS as readonly unknown[]).includes(value);
}

/**
 * The text to encode in a ticket's QR.
 *
 * `sign` is called only for a jwt event. An unrecognised format throws rather
 * than falling back: either default prints a QR that one of the two scanners
 * cannot read, and nobody finds out until the gate.
 */
export function ticketQrPayload(format: TicketQrFormat, jti: string, sign: () => string): string {
  if (!isTicketQrFormat(format)) {
    throw new Error("unknown ticket QR format");
  }
  return format === "uuid" ? jti : sign();
}
