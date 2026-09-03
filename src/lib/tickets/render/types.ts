// ─── Shared inputs for the e-ticket renderers ───────────────────────────────
//
// The PNG and PDF renderers were extracted from the checkout-success page so a
// second page — the payment page a KBZPay buyer actually lands on — can draw the
// same ticket instead of a QR-less receipt screenshot.
//
// They read exactly three fields off the enrollment. Passing that narrow shape
// rather than the whole response is what makes them callable from a page whose
// own data comes from a different endpoint.

import type { SponsorPlacements } from "@/types/database";

export type TicketData = {
  jti: string;
  tier: string;
  admits: number;
  jwt: string;
};

export type TicketRenderContext = {
  enrollmentRef: string;
  eventName: string;
  /** Raw config; resolveSponsorPlacements() runs inside the renderers. */
  sponsorConfig: SponsorPlacements | null | undefined;
};

/** QR data URLs by ticket `jti`. */
export type QrMap = Record<string, string>;
