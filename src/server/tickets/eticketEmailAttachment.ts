import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import { createAdminClient } from "@/lib/supabase/admin";
import { signTicketJwt } from "@/lib/tickets/sign";
import type { EmailAttachment } from "@/lib/email";

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
  const intakeResult = await supabase
    .from("intakes")
    .select("id, name")
    .in("id", intakeIds);
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

export async function renderEticketPdf(enrollmentRef: string, tickets: EmailTicket[]): Promise<string> {
  const width = 148;
  const height = 210;
  const margin = 12;
  const cardWidth = width - margin * 2;
  const cardHeight = 158;
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
    const qr = await QRCode.toDataURL(jwt, { width: 600, margin: 1 });

    pdf.setFillColor(15, 31, 66);
    pdf.roundedRect(margin, margin, cardWidth, cardHeight, 4, 4, "F");

    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(212, 175, 90);
    pdf.setFontSize(5.5);
    pdf.text(fitText(pdf, ticket.eventName.toUpperCase(), cardWidth - 24, 5.5), margin + 12, margin + 18);

    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(11);
    pdf.text(fitText(pdf, ticket.tier, cardWidth - 24, 11), margin + 12, margin + 43);

    pdf.setDrawColor(255, 255, 255);
    pdf.setLineDashPattern([1, 1], 0);
    pdf.line(margin + 12, margin + 48, width - margin - 12, margin + 48);
    pdf.setLineDashPattern([], 0);

    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(138, 144, 165);
    pdf.setFontSize(4.5);
    pdf.text("ORDER REF", margin + 12, margin + 59);
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(7);
    pdf.text(fitText(pdf, enrollmentRef, cardWidth - 24, 7), margin + 12, margin + 73);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(138, 144, 165);
    pdf.setFontSize(4.5);
    pdf.text(`Ticket #${ticket.id.slice(0, 8)}`, margin + 12, margin + 84);

    const qrSize = 65;
    const qrX = (width - qrSize) / 2;
    const qrY = margin + 91;
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(qrX - 3, qrY - 3, qrSize + 6, qrSize + 6, 3, 3, "F");
    pdf.addImage(qr, "PNG", qrX, qrY, qrSize, qrSize);
    pdf.setTextColor(138, 144, 165);
    pdf.setFontSize(4.5);
    pdf.text("Scan at entry", width / 2, qrY + qrSize + 12, { align: "center" });
  }

  return Buffer.from(pdf.output("arraybuffer")).toString("base64");
}

function fitText(pdf: jsPDF, value: string, maxWidth: number, size: number): string {
  pdf.setFontSize(size);
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
