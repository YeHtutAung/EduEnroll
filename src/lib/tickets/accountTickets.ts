// ─── Account-bound tickets on the order pages (design 8.1) ──────────────────
//
// GET /api/public/enrollment/[ref] leaves out every ticket on a protected
// event and says how many there are in `account_ticket_count` (absent when
// none). The checkout success page and /enroll/payment/[ref] send the buyer to
// /account/tickets for those, and must count them as issued tickets.

export const ACCOUNT_TICKETS_PATH = "/account/tickets";

/** The order's account-bound ticket count; anything unreadable is none. */
export function accountTicketCountOf(data: { account_ticket_count?: unknown } | null | undefined): number {
  const n = data?.account_ticket_count;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * A confirmed event order with no ticket at all is an issuance failure. An
 * order whose tickets are all on the buyer's account is not: it has tickets,
 * just not on this page.
 */
export function orderTicketsMissing(input: {
  ticketCount: number;
  accountTicketCount: number;
  ticketsExpected: boolean;
}): boolean {
  return input.ticketsExpected && input.ticketCount + input.accountTicketCount === 0;
}
