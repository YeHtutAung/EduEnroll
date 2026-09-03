// ─── Tickets as a multi-page PDF, drawn with jsPDF primitives ───────────────
//
// A second implementation of the layout in ticketPng.ts, for the reason given
// there: html2canvas cannot reliably rasterise the data-URI QR, so the PDF is
// drawn with jsPDF primitives and the QR placed via addImage. The duplication
// is pre-existing and was moved intact.
//
// Returns the document; the caller decides whether to save, share or inspect it.

import { jsPDF } from "jspdf";
import { resolveSponsorPlacements } from "@/lib/sponsors";
import type { Sponsor } from "@/types/database";
import {
  headerRightReserve,
  TICKET_ROWS,
  TICKET_CARD,
  TICKET_FONT,
  qrTop,
} from "@/lib/tickets/ticketLayout";
import { imageDataUrl } from "./primitives";
import type { QrMap, TicketData, TicketRenderContext } from "./types";

export async function buildTicketPdf(
  info: TicketRenderContext,
  tickets: TicketData[],
  qrMap: QrMap,
): Promise<jsPDF> {
  const sponsorConfig = resolveSponsorPlacements(info.sponsorConfig);

  const W = TICKET_CARD.pageWidth;
  const H = TICKET_CARD.pageHeight;
  const m = TICKET_CARD.margin;
  const cardW = W - 2 * m;
  const cardH = TICKET_CARD.cardHeight;
  const pdf = new jsPDF({ unit: "mm", format: [W, H] });

  const logoSponsors = [sponsorConfig.presenting, ...sponsorConfig.supported_by].filter(
    (sponsor): sponsor is Sponsor => Boolean(sponsor?.logo_url),
  );
  const logoEntries = await Promise.all(
    logoSponsors.map(
      async (sponsor) =>
        [sponsor.logo_url as string, await imageDataUrl(sponsor.logo_url as string)] as const,
    ),
  );
  const sponsorImages = new Map(logoEntries);

  const drawPdfSponsor = (
    sponsor: Sponsor,
    x: number,
    y: number,
    markSize: number,
    maxLogoWidth: number,
    align: "left" | "center" | "right" = "left",
    light = false,
  ) => {
    const image = sponsor.logo_url ? sponsorImages.get(sponsor.logo_url) : null;
    if (image) {
      try {
        const props = pdf.getImageProperties(image);
        const ratio = Math.min(maxLogoWidth / props.width, markSize / props.height);
        const width = props.width * ratio;
        const height = props.height * ratio;
        const dx = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
        pdf.addImage(image, "PNG", dx, y - height / 2, width, height);
        return;
      } catch {
        // Fall through to the placeholder wordmark.
      }
    }

    pdf.setFont("helvetica", "bold");
    const gap = 1.2;

    // Same bound as the canvas twin. `maxLogoWidth` constrains the logo
    // branch only, so a text-only sponsor — or one whose logo failed to
    // load and fell through to here — could still overrun its slot and
    // collide with the next name in the "SUPPORTED BY" strip.
    // "..." rather than "…", which is not in the standard PDF encoding.
    const wordBudget = Math.max(maxLogoWidth - markSize - gap, 4);
    let name = sponsor.name;
    if (pdf.getTextWidth(name) > wordBudget) {
      while (name.length > 1 && pdf.getTextWidth(`${name}...`) > wordBudget) {
        name = name.slice(0, -1);
      }
      name = `${name}...`;
    }
    const wordWidth = pdf.getTextWidth(name);
    const groupWidth = markSize + gap + wordWidth;
    const startX =
      align === "right" ? x - groupWidth : align === "center" ? x - groupWidth / 2 : x;
    const shape = sponsor.mark ?? "square";
    const color = sponsor.mark_color || (shape === "circle" ? "#d4af5a" : "#0f1f42");
    pdf.setFillColor(color);
    pdf.setDrawColor(color);
    if (shape === "circle") pdf.circle(startX + markSize / 2, y, markSize / 2, "F");
    else if (shape === "ring") {
      pdf.setLineWidth(Math.max(0.5, markSize / 5));
      pdf.circle(startX + markSize / 2, y, markSize * 0.35, "S");
    } else if (shape === "diamond") {
      const half = markSize * 0.42;
      pdf.lines(
        [
          [half, half],
          [-half, half],
          [-half, -half],
          [half, -half],
        ],
        startX + markSize / 2,
        y - half,
        [1, 1],
        "F",
        true,
      );
    } else pdf.roundedRect(startX, y - markSize / 2, markSize, markSize, 0.6, 0.6, "F");
    pdf.setTextColor(light ? 255 : 15, light ? 255 : 31, light ? 255 : 66);
    pdf.text(name, startX + markSize + gap, y + 0.8);
  };

  tickets.forEach((ticket, i) => {
    if (i > 0) pdf.addPage([W, H]);

    // Navy card
    pdf.setFillColor(15, 31, 66);
    pdf.roundedRect(m, m, cardW, cardH, 4, 4, "F");

    const padX = TICKET_CARD.padX;

    /**
     * jsPDF twin of the canvas `fitText`: shrink to the largest size that
     * fits, then ellipsise only if it still will not. The PDF layout used
     * the same fixed sizes and coordinates as the canvas, so it overflowed
     * identically — long tiers and refs ran past the card edge.
     * "..." rather than "…", which is not in the standard PDF encoding.
     */
    const fitPdf = (
      text: string,
      maxWidth: number,
      size: number,
      minSize = size * 0.55,
    ): string => {
      let s = size;
      pdf.setFontSize(s);
      while (pdf.getTextWidth(text) > maxWidth && s > minSize) {
        s -= 0.25;
        pdf.setFontSize(s);
      }
      if (pdf.getTextWidth(text) <= maxWidth) return text;
      let clipped = text;
      while (clipped.length > 1 && pdf.getTextWidth(`${clipped}...`) > maxWidth) {
        clipped = clipped.slice(0, -1);
      }
      return `${clipped}...`;
    };

    // Event name (gold) + ticket index (right)
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(212, 175, 90);
    // Mirrors the canvas: the name takes the full width and the ticket
    // index moves to its own line, omitted when there is only one.
    const pdfShowIndex = tickets.length > 1;
    pdf.setFontSize(6);
    const headerReserve = headerRightReserve({
      measure: (t) => pdf.getTextWidth(t),
      gap: 2,
      sponsorReserve: sponsorConfig.presenting ? 42 : 0,
      sponsorName: sponsorConfig.presenting?.logo_url
        ? null
        : (sponsorConfig.presenting?.name ?? null),
      sponsorMarkAllowance: 7,
    });
    pdf.text(
      fitPdf(
        (info.eventName || "").toUpperCase(),
        W - padX * 2 - headerReserve,
        TICKET_FONT.eventName,
      ),
      padX,
      m + TICKET_ROWS.eventName,
    );
    if (sponsorConfig.presenting) {
      const presentingHasLogo = Boolean(sponsorConfig.presenting.logo_url);
      pdf.setTextColor(138, 144, 165);
      pdf.setFontSize(5.5);
      pdf.text("PRESENTED BY", W - padX, m + TICKET_ROWS.presentedByCaption, {
        align: "right",
      });
      if (presentingHasLogo) {
        pdf.setFillColor(255, 255, 255);
        pdf.roundedRect(W - padX - 38, m + 9, 38, 10, 2, 2, "F");
      }
      pdf.setFontSize(7.5);
      drawPdfSponsor(
        sponsorConfig.presenting,
        W - padX,
        m + (presentingHasLogo ? 14 : 13),
        presentingHasLogo ? 5.5 : 3.4,
        34,
        "right",
        !presentingHasLogo,
      );
    } else {
      pdf.setTextColor(138, 144, 165);
    }



    // Tier (white, large)
    pdf.setTextColor(255, 255, 255);
    pdf.text(fitPdf(ticket.tier, W - padX * 2, TICKET_FONT.tier), padX, m + TICKET_ROWS.tier);

    // Dashed divider
    pdf.setDrawColor(255, 255, 255);
    pdf.setLineWidth(0.2);
    pdf.setLineDashPattern([1, 1], 0);
    pdf.line(padX, m + 31, W - padX, m + 31);
    pdf.setLineDashPattern([], 0);

    // Order ref + ticket id
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(138, 144, 165);
    pdf.setFontSize(TICKET_FONT.orderRefLabel);
    pdf.text("ORDER REF", padX, m + TICKET_ROWS.orderRefLabel);
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(255, 255, 255);
    pdf.text(fitPdf(info.enrollmentRef, W - padX * 2, TICKET_FONT.orderRef), padX, m + TICKET_ROWS.orderRef);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(138, 144, 165);
    pdf.setFontSize(TICKET_FONT.ticketId);
    const pdfIdLine = pdfShowIndex
      ? `Ticket #${ticket.jti.slice(0, 8)} - ${i + 1} of ${tickets.length}`
      : `Ticket #${ticket.jti.slice(0, 8)}`;
    pdf.text(fitPdf(pdfIdLine, W - padX * 2, TICKET_FONT.ticketId), padX, m + TICKET_ROWS.ticketId);

    // QR on a white chip, centered near the bottom of the card
    const qr = qrMap[ticket.jti];
    if (qr) {
      const qs = TICKET_CARD.qrSize;
      const qx = (W - qs) / 2;
      // Same collision as the canvas: the QR's white chip starts 3 above
      // qy, which sat over the "Ticket #" line.
      const qy = qrTop();
      pdf.setFillColor(255, 255, 255);
      pdf.roundedRect(
        qx - TICKET_CARD.qrWhitePad,
        qy - TICKET_CARD.qrWhitePad,
        qs + TICKET_CARD.qrWhitePad * 2,
        qs + TICKET_CARD.qrWhitePad * 2,
        2,
        2,
        "F",
      );
      pdf.addImage(qr, "PNG", qx, qy, qs, qs);
      pdf.setTextColor(138, 144, 165);
      pdf.setFontSize(TICKET_CARD.qrCaptionSize);
      pdf.text("Scan at entry", W / 2, qy + qs + TICKET_CARD.qrCaptionGap, { align: "center" });
    }

    if (sponsorConfig.supported_by.length > 0) {
      const stripY = m + cardH + TICKET_CARD.sponsorStripTop;
      const stripH = TICKET_CARD.sponsorStripHeight;
      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(227, 224, 214);
      pdf.setLineWidth(0.25);
      pdf.roundedRect(m, stripY, cardW, stripH, 3, 3, "FD");
      pdf.setFont("helvetica", "bold");
      pdf.setTextColor(172, 167, 149);
      pdf.setFontSize(5.5);
      pdf.text("SUPPORTED BY", W / 2, stripY + 6, { align: "center" });
      const visible = sponsorConfig.supported_by.slice(0, 4);
      const slotWidth = cardW / visible.length;
      visible.forEach((sponsor, index) => {
        pdf.setFontSize(6.2);
        drawPdfSponsor(
          sponsor,
          m + slotWidth * (index + 0.5),
          stripY + 12.5,
          2.5,
          Math.max(12, 62 / visible.length),
          "center",
        );
      });
    }
  });


  return pdf;
}
