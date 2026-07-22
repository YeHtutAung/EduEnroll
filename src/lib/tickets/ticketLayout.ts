/**
 * Geometry helpers shared by the two e-ticket renderers (canvas PNG and jsPDF).
 *
 * Both draw the event name on the left of the ticket header and either a
 * presenting sponsor or a "Ticket i/n" label on the right. The name is fitted
 * to a budget, and the budget is whatever the right-hand block does not use.
 *
 * That budget used to be a guessed constant. On the canvas it reserved 132px
 * for a label that measures 190.7px, so the fitted event name still ran 46px
 * into "Ticket 1/1" — and further with multi-digit counts ("Ticket 10/10"
 * measures 237.4px). Fitting cannot save a layout whose budget is wrong.
 */

export interface HeaderReserveInput {
  /** Right-hand text label, e.g. "Ticket 1/1". Null when a sponsor sits there. */
  label: string | null;
  /** Measures text at the size the right-hand block is actually drawn in. */
  measure: (text: string) => number;
  /** Breathing room between the event name and the right-hand block. */
  gap: number;
  /** Floor for the presenting-sponsor block, which is drawn, not measured. */
  sponsorReserve: number;
  /** Sponsor name, when one occupies the slot without a logo. */
  sponsorName?: string | null;
  /** Width of the sponsor's mark plus its gap, when drawn as a wordmark. */
  sponsorMarkAllowance?: number;
}

/**
 * Width to keep clear on the right of the ticket header.
 *
 * Always derived from a measurement, never from a fixed guess: a label's width
 * depends on the font, the ticket count's digits and the sponsor's name.
 */
export function headerRightReserve({
  label,
  measure,
  gap,
  sponsorReserve,
  sponsorName,
  sponsorMarkAllowance = 0,
}: HeaderReserveInput): number {
  if (label !== null) return measure(label) + gap;

  // A presenting sponsor with a logo occupies a fixed box; one without is a
  // wordmark whose width depends on the name, so take whichever is wider.
  const wordmark = sponsorName ? measure(sponsorName) + sponsorMarkAllowance + gap : 0;
  return Math.max(sponsorReserve, wordmark);
}
