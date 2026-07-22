/**
 * Geometry helpers shared by the two e-ticket renderers (canvas PNG and jsPDF).
 *
 * Both draw the event name on the left of the ticket header, with a presenting
 * sponsor optionally occupying the right. The name is fitted to whatever width
 * the sponsor block does not use.
 *
 * That budget used to be a guessed constant, which under-reserved and let the
 * name collide with what sat beside it. It is now always derived from a
 * measurement.
 */

export interface HeaderReserveInput {
  /** Measures text at the size the sponsor block is actually drawn in. */
  measure: (text: string) => number;
  /** Breathing room between the event name and the sponsor block. */
  gap: number;
  /** Floor for a presenting sponsor with a logo, which is a fixed drawn box. */
  sponsorReserve: number;
  /** Sponsor name, when one occupies the slot without a logo. */
  sponsorName?: string | null;
  /** Width of the sponsor's mark plus its gap, when drawn as a wordmark. */
  sponsorMarkAllowance?: number;
}

/**
 * Width to keep clear on the right of the ticket header.
 *
 * There is no "text label" branch: the ticket index does not live in the header
 * any more, so a `label` parameter would be a path no renderer takes — and
 * tests covering it would exercise nothing production runs.
 */
export function headerRightReserve({
  measure,
  gap,
  sponsorReserve,
  sponsorName,
  sponsorMarkAllowance = 0,
}: HeaderReserveInput): number {
  // A presenting sponsor with a logo occupies a fixed box; one without is a
  // wordmark whose width depends on the name, so take whichever is wider.
  const wordmark = sponsorName ? measure(sponsorName) + sponsorMarkAllowance + gap : 0;
  return Math.max(sponsorReserve, wordmark);
}

// ─── Bounding boxes ─────────────────────────────────────────────────────────
//
// Baseline ordering is NOT separation. A ticket index placed at baseline 156,
// between the event name (120) and the tier (204), still overlapped the tier:
// at 87px the tier's glyph box begins at y=141, and the index's box ended at
// y=156. Fifteen pixels of overlap, horizontally too. Anything that reasons
// about vertical layout has to reason about boxes.

export interface Box {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

/**
 * Helvetica's ascent and descent as fractions of the em size.
 *
 * Measured from the real canvas: caps rise 0.718em above the baseline and
 * descenders fall 0.207em below it. Rounded outward so a box computed here is
 * never smaller than the glyphs actually drawn.
 */
export const ASCENT_RATIO = 0.73;
export const DESCENT_RATIO = 0.21;

export function boxFor(opts: {
  /** Anchor x: the left edge for "left", the right edge for "right". */
  x: number;
  baseline: number;
  width: number;
  fontSize: number;
  align?: "left" | "right";
  ascentRatio?: number;
  descentRatio?: number;
}): Box {
  const {
    x,
    baseline,
    width,
    fontSize,
    align = "left",
    ascentRatio = ASCENT_RATIO,
    descentRatio = DESCENT_RATIO,
  } = opts;
  const x0 = align === "right" ? x - width : x;
  return {
    x0,
    x1: x0 + width,
    top: baseline - fontSize * ascentRatio,
    bottom: baseline + fontSize * descentRatio,
  };
}

/** True when two drawn boxes share any area — i.e. text lands on text. */
export function overlaps(a: Box, b: Box): boolean {
  const apart = a.bottom <= b.top || b.bottom <= a.top || a.x1 <= b.x0 || b.x1 <= a.x0;
  return !apart;
}

/**
 * Baselines of the ticket card's text rows, in layout units.
 *
 * Canvas multiplies these by S; the PDF uses them as millimetres. Keeping the
 * numbers in one place is what lets a test check both coordinate systems
 * against the same layout.
 */
export const TICKET_ROWS = {
  eventName: 12,
  tier: 26,
  orderRefLabel: 38,
  orderRef: 47,
  /** Ticket id, and the "N of M" index when there is more than one ticket. */
  ticketId: 54,
} as const;
