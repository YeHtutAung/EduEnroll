import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import { createAdminClient } from "@/lib/supabase/admin";
import { signTicketJwt } from "@/lib/tickets/sign";
import type { EmailAttachment } from "@/lib/email";
import { TICKET_CARD, TICKET_FONT, TICKET_ROWS, qrTop } from "@/lib/tickets/ticketLayout";

type TicketRow = {
  id: string;
  intake_id: string;
  tier: string;
  admits: number;
  exp: string;
};

type EmailTicket = TicketRow & { eventName: string };

/**
 * Builds the PDF attached to a paid event's confirmation email. The browser
 * renderer cannot run in a payment webhook, so this intentionally uses only
 * server-compatible jsPDF and QRCode APIs.
 */
export async function buildEticketEmailAttachment(
  enrollmentId: string,
): Promise<EmailAttachment | null> {
  const supabase = createAdminClient();

  const [enrollmentResult, ticketResult] = await Promise.all([
    supabase.from("enrollments").select("enrollment_ref").eq("id", enrollmentId).maybeSingle(),
    supabase
      .from("tickets")
      .select("id, intake_id, tier, admits, exp")
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
  if (!enrollment || !rows?.length) return null;

  const ticketRows = rows as TicketRow[];
  const intakeIds = [...new Set(ticketRows.map((ticket) => ticket.intake_id))];
  const intakeResult = await supabase.from("intakes").select("id, name").in("id", intakeIds);
  const { data: intakes, error: intakeError } = intakeResult as unknown as {
    data: { id: string; name: string }[] | null;
    error: unknown;
  };

  if (intakeError) throw new Error("could not load event details for e-ticket attachment");
  const names = new Map((intakes ?? []).map((intake) => [intake.id, intake.name]));
  const tickets = ticketRows.map((ticket) => ({
    ...ticket,
    eventName: names.get(ticket.intake_id) ?? "Event",
  }));

  const content = await renderEticketPdf(enrollment.enrollment_ref, tickets);
  return {
    filename: `eticket-${safeFilename(enrollment.enrollment_ref)}.pdf`,
    content,
  };
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

    const jwt = signTicketJwt({
      jti: ticket.id,
      eid: ticket.intake_id,
      tier: ticket.tier,
      admits: ticket.admits,
      exp: Math.floor(Date.parse(ticket.exp) / 1000),
    });
    const qr = await QRCode.toDataURL(jwt, { width: 240, margin: 1 });

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
    pdf.text(`Ticket #${ticket.id.slice(0, 8)}`, padX, margin + TICKET_ROWS.ticketId);

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
