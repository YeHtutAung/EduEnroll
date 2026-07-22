import { describe, it, expect } from "vitest";
import { jsPDF } from "jspdf";
import {
  boxFor,
  overlaps,
  TICKET_ROWS,
  TICKET_CARD,
  TICKET_FONT,
  qrTop,
  type Box,
} from "@/lib/tickets/ticketLayout";

// ─── Whole-card geometry, measured per renderer ─────────────────────────────
//
// The row guard covered text against text and missed the card boundary: moving
// the metadata line down pushed "Scan at entry" 8px BELOW the navy card, in
// both renderers. So this asserts the full set — text rows, the QR panel, the
// caption and the card edge — and it does so with each renderer's own font
// metrics rather than one renderer's numbers scaled to the other.
//
// The PDF pass drives a real jsPDF instance and uses getTextDimensions, so it
// measures jsPDF's Helvetica rather than assuming the canvas's.

const CARD = {
  left: TICKET_CARD.padX,
  right: TICKET_CARD.pageWidth - TICKET_CARD.padX,
  bottom: TICKET_CARD.margin + TICKET_CARD.cardHeight,
};

const ID_LINE = "Ticket #b131e09c · 1 of 2";

/**
 * Rows drawn on the common card: no presenting sponsor.
 *
 * `presentedByCaption` is excluded deliberately — it is only drawn in the
 * sponsor variant, where the header is a different layout, so asserting it
 * here would test a card that is never rendered.
 */
const ROWS_UNDER_TEST = [
  "eventName",
  "tier",
  "orderRefLabel",
  "orderRef",
  "ticketId",
] as const satisfies readonly (keyof typeof TICKET_ROWS)[];
const CAPTION = "Scan at entry";

// ── Canvas metrics, measured in a real browser on Helvetica ────────────────
// (actualBoundingBoxAscent / actualBoundingBoxDescent ÷ font size)
const CANVAS_METRICS: Record<string, { size: number; asc: number; desc: number; width: number }> = {
  eventName: { size: 6.5, asc: 0.7179, desc: 0, width: 67.19 },
  tier: { size: 14.5, asc: 0.7241, desc: 0.2069, width: 66.89 },
  orderRefLabel: { size: 6, asc: 0.7222, desc: 0, width: 35.33 },
  orderRef: { size: 10.75, asc: 0.7442, desc: 0.0775, width: 66.91 },
  ticketId: { size: 6, asc: 0.7222, desc: 0, width: 67.49 },
  caption: { size: TICKET_CARD.qrCaptionSize, asc: 0.7222, desc: 0.1944, width: 35.35 },
};

function canvasBoxes(): Record<string, Box> {
  const out: Record<string, Box> = {};
  for (const key of ROWS_UNDER_TEST) {
    const m = CANVAS_METRICS[key];
    out[key] = boxFor({
      x: CARD.left,
      baseline: TICKET_CARD.margin + TICKET_ROWS[key],
      width: m.width,
      fontSize: m.size,
      ascentRatio: m.asc,
      descentRatio: m.desc,
    });
  }
  const top = qrTop();
  out.qrPanel = {
    x0: (TICKET_CARD.pageWidth - TICKET_CARD.qrSize) / 2 - TICKET_CARD.qrWhitePad,
    x1: (TICKET_CARD.pageWidth + TICKET_CARD.qrSize) / 2 + TICKET_CARD.qrWhitePad,
    top: top - TICKET_CARD.qrWhitePad,
    bottom: top + TICKET_CARD.qrSize + TICKET_CARD.qrWhitePad,
  };
  const cap = CANVAS_METRICS.caption;
  out.caption = boxFor({
    x: TICKET_CARD.pageWidth / 2 - cap.width / 2,
    baseline: top + TICKET_CARD.qrSize + TICKET_CARD.qrCaptionGap,
    width: cap.width,
    fontSize: cap.size,
    ascentRatio: cap.asc,
    descentRatio: cap.desc,
  });
  return out;
}

/** PDF boxes measured from a real jsPDF document. */
function pdfBoxes(): Record<string, Box> {
  const pdf = new jsPDF({ unit: "mm", format: [TICKET_CARD.pageWidth, TICKET_CARD.pageHeight] });
  const avail = CARD.right - CARD.left;

  const fit = (text: string, base: number, weight: "bold" | "normal") => {
    pdf.setFont("helvetica", weight);
    let size = base;
    pdf.setFontSize(size);
    while (pdf.getTextWidth(text) > avail && size > base * 0.55) {
      size -= 0.25;
      pdf.setFontSize(size);
    }
    return size;
  };

  const row = (key: keyof typeof TICKET_ROWS, text: string, base: number, weight: "bold" | "normal") => {
    const size = fit(text, base, weight);
    const dims = pdf.getTextDimensions(text); // real jsPDF metrics at current size
    return boxFor({
      x: CARD.left,
      baseline: TICKET_CARD.margin + TICKET_ROWS[key],
      width: dims.w,
      fontSize: size,
      // jsPDF reports total line height; split it the way Helvetica sits.
      ascentRatio: (dims.h / size) * 0.78,
      descentRatio: (dims.h / size) * 0.22,
    });
  };

  const out: Record<string, Box> = {
    eventName: row("eventName", "AUGUST 2026 EVENT", TICKET_FONT.eventName, "bold"),
    tier: row("tier", "Early bird", TICKET_FONT.tier, "bold"),
    orderRefLabel: row("orderRefLabel", "ORDER REF", TICKET_FONT.orderRefLabel, "normal"),
    orderRef: row("orderRef", "F-0722-CEQ7", TICKET_FONT.orderRef, "bold"),
    ticketId: row("ticketId", ID_LINE, TICKET_FONT.ticketId, "normal"),
  };

  const top = qrTop();
  out.qrPanel = {
    x0: (TICKET_CARD.pageWidth - TICKET_CARD.qrSize) / 2 - TICKET_CARD.qrWhitePad,
    x1: (TICKET_CARD.pageWidth + TICKET_CARD.qrSize) / 2 + TICKET_CARD.qrWhitePad,
    top: top - TICKET_CARD.qrWhitePad,
    bottom: top + TICKET_CARD.qrSize + TICKET_CARD.qrWhitePad,
  };

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(TICKET_CARD.qrCaptionSize);
  const capDims = pdf.getTextDimensions(CAPTION);
  out.caption = boxFor({
    x: TICKET_CARD.pageWidth / 2 - capDims.w / 2,
    baseline: top + TICKET_CARD.qrSize + TICKET_CARD.qrCaptionGap,
    width: capDims.w,
    fontSize: TICKET_CARD.qrCaptionSize,
    ascentRatio: (capDims.h / TICKET_CARD.qrCaptionSize) * 0.78,
    descentRatio: (capDims.h / TICKET_CARD.qrCaptionSize) * 0.22,
  });
  return out;
}

function collisions(boxes: Record<string, Box>): string[] {
  const keys = Object.keys(boxes);
  const found: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (overlaps(boxes[keys[i]], boxes[keys[j]])) found.push(`${keys[i]} ∩ ${keys[j]}`);
    }
  }
  return found;
}

describe.each([
  ["canvas", canvasBoxes],
  ["pdf (real jsPDF metrics)", pdfBoxes],
])("ticket card geometry — %s", (_name, build) => {
  it("has no overlapping elements", () => {
    expect(collisions(build())).toEqual([]);
  });

  it("keeps every element inside the card", () => {
    for (const [key, box] of Object.entries(build())) {
      expect(box.bottom, `${key} extends below the card`).toBeLessThanOrEqual(CARD.bottom);
      expect(box.x0, `${key} starts before the card`).toBeGreaterThanOrEqual(CARD.left - 0.01);
      expect(box.x1, `${key} runs past the card`).toBeLessThanOrEqual(CARD.right + 0.01);
    }
  });

  it("keeps the QR caption above the card edge", () => {
    // The reported regression: at qrSize 44 the caption's descender fell 8px
    // (canvas) below the navy card in both renderers.
    const { caption } = build();
    expect(caption.bottom).toBeLessThan(CARD.bottom);
  });
});

describe("measured metrics stay in step with the font constants", () => {
  // The canvas pass reads a hardcoded table of MEASURED metrics, so it cannot
  // notice a change to TICKET_FONT on its own — lower a base size and the table
  // silently describes a card that is no longer rendered. A fitted size can
  // never exceed its base, so this catches exactly that drift and forces a
  // re-measure.
  it.each(Object.keys(TICKET_FONT) as (keyof typeof TICKET_FONT)[])(
    "%s: recorded size does not exceed its base",
    (key) => {
      expect(
        CANVAS_METRICS[key].size,
        `CANVAS_METRICS.${key} was measured at ${CANVAS_METRICS[key].size} but TICKET_FONT.${key} is now ${TICKET_FONT[key]} — re-measure the table`,
      ).toBeLessThanOrEqual(TICKET_FONT[key]);
    },
  );

  it("caption metrics match the configured caption size", () => {
    expect(CANVAS_METRICS.caption.size).toBe(TICKET_CARD.qrCaptionSize);
  });
});

describe("card constants", () => {
  it("keeps the QR clear of the ticket-id line", () => {
    const top = qrTop();
    expect(top - TICKET_CARD.qrWhitePad).toBeGreaterThan(
      TICKET_CARD.margin + TICKET_ROWS.ticketId + TICKET_CARD.idLineDescender,
    );
  });

  it("leaves the sponsor strip inside the page", () => {
    const stripBottom =
      TICKET_CARD.margin +
      TICKET_CARD.cardHeight +
      TICKET_CARD.sponsorStripTop +
      TICKET_CARD.sponsorStripHeight;
    expect(stripBottom).toBeLessThanOrEqual(TICKET_CARD.pageHeight);
  });
});
