import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import { createAdminClient } from "@/lib/supabase/admin";
import { signTicketJwt } from "@/lib/tickets/sign";
import { isTicketQrFormat, ticketQrPayload, type TicketQrFormat } from "@/lib/tickets/qrPayload";
import type { EmailAttachment } from "@/lib/email";
import { TICKET_CARD, TICKET_FONT, TICKET_ROWS, pdfHolder, qrTop, ticketIdLine } from "@/lib/tickets/ticketLayout";

type TicketRow = {
  id: string;
  intake_id: string;
  tier: string;
  admits: number;
  exp: string;
  class_id?: string;
  seat_no?: number;
  /** {label, answers} copied from the order's runners at issue; null without. */
  attendee?: { label?: unknown } | null;
};

type EmailTicket = TicketRow & { eventName: string; qrFormat: TicketQrFormat };

/**
 * What a confirmation email carries for an order's tickets (design 8.1).
 *
 * - `attachment`: the PDF of the order's tickets that are NOT on an
 *   account-bound (protected) event, or null when there are none or the PDF
 *   could not be made.
 * - `accountTickets`: true when at least one ticket is on a protected event.
 *   Those tickets are never signed, drawn or attached here; the email links to
 *   /account/tickets on the tenant's host instead.
 *
 * The one helper every confirmation email asks, so no caller can forget the
 * rule. A PDF failure gives `attachment: null` with `accountTickets` still
 * right; only a failure to read the tickets or their events throws, and
 * callers then fall back to NO_TICKET_EMAIL_PARTS (no PDF, no button).
 */
export type TicketEmailParts = {
  attachment: EmailAttachment | null;
  accountTickets: boolean;
};

/** What a caller uses when buildTicketEmailParts throws: today's "no PDF". */
export const NO_TICKET_EMAIL_PARTS: TicketEmailParts = Object.freeze({
  attachment: null,
  accountTickets: false,
}) as TicketEmailParts;

/** The signed-in ticket page on the same (tenant) host as `tenantUrl`. */
export function accountTicketsUrl(tenantUrl: string): string {
  return new URL("/account/tickets", tenantUrl).toString();
}

/**
 * Builds the PDF attached to a paid event's confirmation email. The browser
 * renderer cannot run in a payment webhook, so this intentionally uses only
 * server-compatible jsPDF and QRCode APIs.
 */
export async function buildTicketEmailParts(enrollmentId: string): Promise<TicketEmailParts> {
  const supabase = createAdminClient();

  const [enrollmentResult, ticketResult] = await Promise.all([
    supabase.from("enrollments").select("enrollment_ref").eq("id", enrollmentId).maybeSingle(),
    supabase
      .from("tickets")
      .select("id, intake_id, tier, admits, exp, class_id, seat_no, attendee")
      .eq("enrollment_id", enrollmentId)
      .eq("status", "valid"),
  ]);
  const { data: enrollment, error: enrollmentError } = enrollmentResult as unknown as {
    data: { enrollment_ref: string } | null;
    error: unknown;
  };
  const { data: rows, error: ticketError } = ticketResult as unknown as {
    data: TicketRow[] | null;
    error: unknown;
  };

  if (enrollmentError) throw new Error("could not load enrollment for e-ticket attachment");
  if (ticketError) throw new Error("could not load issued tickets for e-ticket attachment");
  if (!enrollment || !rows?.length) return { attachment: null, accountTickets: false };

  // Seat order, so each runner's page follows the order they were entered in.
  const ticketRows = [...(rows as TicketRow[])].sort(bySeat);
  const intakeIds = [...new Set(ticketRows.map((ticket) => ticket.intake_id))];
  const intakeResult = await supabase
    .from("intakes")
    .select("id, name, ticket_qr_format, ticket_protection")
    .in("id", intakeIds);
  const { data: intakes, error: intakeError } = intakeResult as unknown as {
    data: { id: string; name: string; ticket_qr_format: unknown; ticket_protection: unknown }[] | null;
    error: unknown;
  };

  if (intakeError || !intakes) throw new Error("could not load event details for e-ticket attachment");
  const byId = new Map(intakes.map((intake) => [intake.id, intake]));
  // Protection must be known for every ticket before anything is drawn: a
  // ticket whose event is missing could be a protected one.
  if (intakeIds.some((id) => !byId.has(id))) {
    throw new Error("could not load event details for every ticket");
  }

  const isProtected = (ticket: TicketRow) => byId.get(ticket.intake_id)!.ticket_protection === true;
  const accountTickets = ticketRows.some(isProtected);
  const open = ticketRows.filter((ticket) => !isProtected(ticket));
  if (open.length === 0) return { attachment: null, accountTickets };

  try {
    // Checked for every ticket before any is drawn: an event whose format cannot
    // be read gets no attachment rather than a QR its gate may not accept.
    const tickets = open.map((ticket) => {
      const intake = byId.get(ticket.intake_id)!;
      if (!isTicketQrFormat(intake.ticket_qr_format)) throw new Error("unknown ticket QR format");
      return {
        ...ticket,
        eventName: intake.name ?? "Event",
        qrFormat: intake.ticket_qr_format,
      };
    });

    const content = await renderEticketPdf(enrollment.enrollment_ref, tickets);
    return {
      attachment: {
        filename: `eticket-${safeFilename(enrollment.enrollment_ref)}.pdf`,
        content,
      },
      accountTickets,
    };
  } catch (error) {
    console.error("[ticket-email] e-ticket PDF failed:", error instanceof Error ? error.message : "unknown");
    return { attachment: null, accountTickets };
  }
}

export async function renderEticketPdf(
  enrollmentRef: string,
  tickets: EmailTicket[],
): Promise<string> {
  const width = TICKET_CARD.pageWidth;
  const height = TICKET_CARD.pageHeight;
  const margin = TICKET_CARD.margin;
  const cardWidth = width - margin * 2;
  const cardHeight = TICKET_CARD.cardHeight;
  const padX = TICKET_CARD.padX;
  const pdf = new jsPDF({ unit: "mm", format: [width, height] });

  for (const [index, ticket] of tickets.entries()) {
    if (index > 0) pdf.addPage([width, height]);

    const payload = ticketQrPayload(ticket.qrFormat, ticket.id, () =>
      signTicketJwt({
        jti: ticket.id,
        eid: ticket.intake_id,
        tier: ticket.tier,
        admits: ticket.admits,
        exp: Math.floor(Date.parse(ticket.exp) / 1000),
      }),
    );
    const qr = await QRCode.toDataURL(payload, { width: 240, margin: 1 });

    pdf.setFillColor(15, 31, 66);
    pdf.roundedRect(margin, margin, cardWidth, cardHeight, 4, 4, "F");

    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(212, 175, 90);
    pdf.text(
      fitText(pdf, ticket.eventName.toUpperCase(), width - padX * 2, TICKET_FONT.eventName),
      padX,
      margin + TICKET_ROWS.eventName,
    );

    pdf.setTextColor(255, 255, 255);
    pdf.text(
      fitText(pdf, ticket.tier, width - padX * 2, TICKET_FONT.tier),
      padX,
      margin + TICKET_ROWS.tier,
    );

    pdf.setDrawColor(255, 255, 255);
    pdf.setLineDashPattern([1, 1], 0);
    const dividerY = margin + TICKET_ROWS.tier + 3;
    pdf.line(padX, dividerY, width - padX, dividerY);
    pdf.setLineDashPattern([], 0);

    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(138, 144, 165);
    pdf.setFontSize(TICKET_FONT.orderRefLabel);
    pdf.text("ORDER REF", padX, margin + TICKET_ROWS.orderRefLabel);
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(255, 255, 255);
    pdf.text(
      fitText(pdf, enrollmentRef, width - padX * 2, TICKET_FONT.orderRef),
      padX,
      margin + TICKET_ROWS.orderRef,
    );
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(138, 144, 165);
    pdf.setFontSize(TICKET_FONT.ticketId);
    const holder = typeof ticket.attendee?.label === "string" ? ticket.attendee.label : null;
    pdf.text(
      fitText(
        pdf,
        ticketIdLine({ jti: ticket.id, index, count: 1, holder: pdfHolder(holder), sep: " - " }),
        width - padX * 2,
        TICKET_FONT.ticketId,
      ),
      padX,
      margin + TICKET_ROWS.ticketId,
    );

    const qrSize = TICKET_CARD.qrSize;
    const qrX = (width - qrSize) / 2;
    const qrY = qrTop();
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(
      qrX - TICKET_CARD.qrWhitePad,
      qrY - TICKET_CARD.qrWhitePad,
      qrSize + TICKET_CARD.qrWhitePad * 2,
      qrSize + TICKET_CARD.qrWhitePad * 2,
      2,
      2,
      "F",
    );
    pdf.addImage(qr, "PNG", qrX, qrY, qrSize, qrSize);
    pdf.setTextColor(138, 144, 165);
    pdf.setFontSize(TICKET_CARD.qrCaptionSize);
    pdf.text("Scan at entry", width / 2, qrY + qrSize + TICKET_CARD.qrCaptionGap, {
      align: "center",
    });
  }

  return Buffer.from(pdf.output("arraybuffer")).toString("base64");
}

function fitText(pdf: jsPDF, value: string, maxWidth: number, size: number): string {
  let fontSize = size;
  pdf.setFontSize(fontSize);
  while (pdf.getTextWidth(value) > maxWidth && fontSize > size * 0.55) {
    fontSize -= 0.25;
    pdf.setFontSize(fontSize);
  }
  if (pdf.getTextWidth(value) <= maxWidth) return value;

  let shortened = value;
  while (shortened.length > 1 && pdf.getTextWidth(`${shortened}...`) > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened}...`;
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_");
}

function bySeat(a: TicketRow, b: TicketRow): number {
  const byClass = (a.class_id ?? "").localeCompare(b.class_id ?? "");
  return byClass !== 0 ? byClass : (a.seat_no ?? 0) - (b.seat_no ?? 0);
}
