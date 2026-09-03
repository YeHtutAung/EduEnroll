// ─── Ticket as a PNG, drawn with canvas primitives ──────────────────────────
//
// Canvas rather than html2canvas: html2canvas cannot reliably rasterise a
// data-URI <img>, which is exactly what the QR is. That constraint is also why
// a second, jsPDF implementation of this same layout exists in ticketPdf.ts —
// see the plan; unifying them is deliberately out of scope.

import QRCode from "qrcode";
import { resolveSponsorPlacements } from "@/lib/sponsors";
import {
  headerRightReserve,
  TICKET_ROWS,
  TICKET_CARD,
  TICKET_FONT,
  qrTop,
} from "@/lib/tickets/ticketLayout";
import { loadImage, roundRectPath, drawCanvasSponsor } from "./primitives";
import type { QrMap, TicketData, TicketRenderContext } from "./types";

export async function renderTicketPng(
  info: TicketRenderContext,
  ticket: TicketData,
  i: number,
  n: number,
  qrUrl: string,
): Promise<Blob | null> {
  const sponsorConfig = resolveSponsorPlacements(info.sponsorConfig);
  const S = 6;
  const W = TICKET_CARD.pageWidth * S;
  const H = TICKET_CARD.pageHeight * S;
  const m = TICKET_CARD.margin * S;
  const cardW = W - 2 * m;
  const cardH = TICKET_CARD.cardHeight * S;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const font = (px: number, weight = "normal") =>
    `${weight} ${px * S}px Helvetica, Arial, sans-serif`;

  /**
   * Sets ctx.font to the largest size up to `px` at which `text` fits inside
   * `maxWidth`, and returns the text — ellipsised if it will not fit even at
   * the floor size.
   *
   * The layout was written with fixed sizes and no measurement, so anything
   * longer than the samples it was designed against ran past the card: the
   * ticket tier and order ref overflowed the right edge, and the event name
   * collided with the "PRESENTED BY" block. Nothing is truncated for the
   * common short values — they simply fit at full size.
   */
  const fitText = (
    text: string,
    maxWidth: number,
    px: number,
    weight = "normal",
    minPx = px * 0.55,
  ): string => {
    let size = px;
    ctx.font = font(size, weight);
    while (ctx.measureText(text).width > maxWidth && size > minPx) {
      size -= 0.25;
      ctx.font = font(size, weight);
    }
    if (ctx.measureText(text).width <= maxWidth) return text;

    let clipped = text;
    while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
      clipped = clipped.slice(0, -1);
    }
    return `${clipped}…`;
  };

  ctx.fillStyle = "#f7f5ef";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#0f1f42";
  roundRectPath(ctx, m, m, cardW, cardH, 4 * S);
  ctx.fill();

  const padX = TICKET_CARD.padX * S;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#d4af5a";
  ctx.textAlign = "left";
  // The reserve must be MEASURED, not guessed: a fixed 22*S kept 132px clear
  // for a label that measures 190.7px ("Ticket 1/1"), and 237.4px at
  // "Ticket 10/10", so the fitted name still ran into it.
  //
  // Measuring alone was not enough, though. Sharing one 408px line between a
  // long event name and that label forced the name down to 13-18px to fit —
  // unreadable — or ellipsised it to "AUGUST 202…". The name is the primary
  // information, so it now gets the full width and the ticket index moves to
  // its own line beneath. The index is also omitted for a single ticket,
  // where "Ticket 1/1" says nothing.
  const showIndex = n > 1;
  ctx.font = font(6, "bold");
  const reserve = headerRightReserve({
    measure: (t) => ctx.measureText(t).width,
    gap: 4 * S,
    // Only a presenting sponsor still shares the top line.
    sponsorReserve: sponsorConfig.presenting ? 42 * S : 0,
    sponsorName: sponsorConfig.presenting?.logo_url
      ? null
      : (sponsorConfig.presenting?.name ?? null),
    sponsorMarkAllowance: 14 * S,
  });
  const eventNameText = fitText(
    (info.eventName || "").toUpperCase(),
    W - padX * 2 - reserve,
    TICKET_FONT.eventName,
    "bold",
  );
  ctx.fillText(eventNameText, padX, m + TICKET_ROWS.eventName * S);
  if (sponsorConfig.presenting) {
    const presentingHasLogo = Boolean(sponsorConfig.presenting.logo_url);
    ctx.fillStyle = "#8a90a5";
    ctx.font = font(5.5, "bold");
    ctx.textAlign = "right";
    ctx.fillText("PRESENTED BY", W - padX, m + TICKET_ROWS.presentedByCaption * S);
    if (presentingHasLogo) {
      ctx.fillStyle = "#ffffff";
      roundRectPath(ctx, W - padX - 38 * S, m + 9 * S, 38 * S, 12 * S, 2 * S);
      ctx.fill();
    }
    ctx.font = font(7.5, "bold");
    await drawCanvasSponsor(
      ctx,
      sponsorConfig.presenting,
      W - padX,
      m + (presentingHasLogo ? 15 : 13) * S,
      presentingHasLogo ? 8 : 10,
      34,
      S,
      "right",
      !presentingHasLogo,
    );
  }



  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  const tierText = fitText(ticket.tier, W - padX * 2, TICKET_FONT.tier, "bold");
  ctx.fillText(tierText, padX, m + TICKET_ROWS.tier * S);

  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 0.5 * S;
  ctx.setLineDash([1.5 * S, 1.5 * S]);
  ctx.beginPath();
  ctx.moveTo(padX, m + 31 * S);
  ctx.lineTo(W - padX, m + 31 * S);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#8a90a5";
  ctx.font = font(TICKET_FONT.orderRefLabel);
  // The caption sits close above the reference: its glyph box once ended
  // BELOW the reference's top, so this row and TICKET_ROWS.orderRef are kept
  // apart deliberately. See the geometry guard rather than trusting the gap
  // by eye — the numbers live in TICKET_ROWS.
  ctx.fillText("ORDER REF", padX, m + TICKET_ROWS.orderRefLabel * S);
  ctx.fillStyle = "#ffffff";
  const refText = fitText(info.enrollmentRef, W - padX * 2, TICKET_FONT.orderRef, "bold");
  ctx.fillText(refText, padX, m + TICKET_ROWS.orderRef * S);
  ctx.fillStyle = "#8a90a5";
  ctx.font = font(TICKET_FONT.ticketId);
  // The index rides the existing metadata line rather than getting its own.
  // A separate line at m+18*S sat clear of the tier's BASELINE but not its
  // glyph box: at 87px the tier's box starts at y=141, and the index's ended
  // at y=156 — 15px of overlap, horizontally too. Baseline ordering is not
  // separation.
  const idLine = showIndex
    ? `Ticket #${ticket.jti.slice(0, 8)} · ${i + 1} of ${n}`
    : `Ticket #${ticket.jti.slice(0, 8)}`;
  ctx.fillText(
    fitText(idLine, W - padX * 2, TICKET_FONT.ticketId),
    padX,
    m + TICKET_ROWS.ticketId * S,
  );

  const qs = TICKET_CARD.qrSize * S;
  const qx = (W - qs) / 2;
  // The QR's white panel starts 3*S above qy, which sat above the "Ticket #"
  // baseline and covered it. Push the code down if the panel would collide.
  const qy = qrTop(S);
  ctx.fillStyle = "#ffffff";
  roundRectPath(
    ctx,
    qx - TICKET_CARD.qrWhitePad * S,
    qy - TICKET_CARD.qrWhitePad * S,
    qs + TICKET_CARD.qrWhitePad * 2 * S,
    qs + TICKET_CARD.qrWhitePad * 2 * S,
    2 * S,
  );
  ctx.fill();
  const qrImg = await loadImage(qrUrl);
  ctx.drawImage(qrImg, qx, qy, qs, qs);
  ctx.fillStyle = "#8a90a5";
  ctx.font = font(TICKET_CARD.qrCaptionSize);
  ctx.textAlign = "center";
  ctx.fillText("Scan at entry", W / 2, qy + qs + TICKET_CARD.qrCaptionGap * S);

  if (sponsorConfig.supported_by.length > 0) {
    const stripY = m + cardH + TICKET_CARD.sponsorStripTop * S;
    const stripH = TICKET_CARD.sponsorStripHeight * S;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#e3e0d6";
    ctx.lineWidth = S;
    roundRectPath(ctx, m, stripY, cardW, stripH, 3 * S);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#aca795";
    ctx.font = font(5.5, "bold");
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("SUPPORTED BY", W / 2, stripY + 6 * S);

    const visible = sponsorConfig.supported_by.slice(0, 4);
    const slotWidth = cardW / visible.length;
    for (let index = 0; index < visible.length; index++) {
      ctx.font = font(6.2, "bold");
      await drawCanvasSponsor(
        ctx,
        visible[index],
        m + slotWidth * (index + 0.5),
        stripY + 12.5 * S,
        7,
        Math.max(12, 62 / visible.length),
        S,
        "center",
      );
    }
  }

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

/**
 * QR data URLs for every ticket, keyed by `jti`.
 *
 * Both pages need this and both must also regenerate defensively at download
 * time: the button can be tapped before the effect that fills the map settles.
 */
export async function buildQrMap(tickets: TicketData[], existing: QrMap = {}): Promise<QrMap> {
  const map: QrMap = { ...existing };
  await Promise.all(
    tickets.map(async (t) => {
      if (!map[t.jti]) map[t.jti] = await QRCode.toDataURL(t.jwt, { width: 240, margin: 1 });
    }),
  );
  return map;
}
