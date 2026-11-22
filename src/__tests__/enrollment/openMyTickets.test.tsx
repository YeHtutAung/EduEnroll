import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import OpenMyTickets, { OPEN_MY_TICKETS_EN } from "@/components/enroll/OpenMyTickets";
import {
  ACCOUNT_TICKETS_PATH,
  accountTicketCountOf,
  orderTicketsMissing,
} from "@/lib/tickets/accountTickets";

// Task 15 (design 8.1): the success and payment pages send a buyer with
// account-bound tickets to /account/tickets, and never treat an order whose
// tickets are all on the account as "tickets missing".

describe("accountTicketCountOf", () => {
  it("reads a positive whole count and treats anything else as none", () => {
    expect(accountTicketCountOf({ account_ticket_count: 2 })).toBe(2);
    expect(accountTicketCountOf({})).toBe(0);
    expect(accountTicketCountOf(null)).toBe(0);
    expect(accountTicketCountOf({ account_ticket_count: -1 })).toBe(0);
    expect(accountTicketCountOf({ account_ticket_count: "3" })).toBe(0);
    expect(accountTicketCountOf({ account_ticket_count: 1.5 })).toBe(0);
  });
});

describe("orderTicketsMissing", () => {
  it("an all-protected order is not missing its tickets", () => {
    expect(orderTicketsMissing({ ticketCount: 0, accountTicketCount: 2, ticketsExpected: true })).toBe(false);
  });

  it("an event order with neither kind is missing them, as before", () => {
    expect(orderTicketsMissing({ ticketCount: 0, accountTicketCount: 0, ticketsExpected: true })).toBe(true);
  });

  it("a language school order never is", () => {
    expect(orderTicketsMissing({ ticketCount: 0, accountTicketCount: 0, ticketsExpected: false })).toBe(false);
  });

  it("an order with page tickets is not", () => {
    expect(orderTicketsMissing({ ticketCount: 1, accountTicketCount: 0, ticketsExpected: true })).toBe(false);
  });
});

describe("OpenMyTickets", () => {
  it("links to /account/tickets with the bilingual label and no QR or download", () => {
    const html = renderToStaticMarkup(<OpenMyTickets count={2} />);
    expect(ACCOUNT_TICKETS_PATH).toBe("/account/tickets");
    expect(html).toContain('href="/account/tickets"');
    expect(html).toContain(OPEN_MY_TICKETS_EN);
    expect(html).toContain("font-myanmar");
    expect(html).not.toMatch(/<img|<canvas|download/i);
  });

  it("renders nothing without account tickets", () => {
    expect(renderToStaticMarkup(<OpenMyTickets count={0} />)).toBe("");
  });
});

// The pages are client components fed by fetch, so these check the wiring in
// the source; the decisions themselves are tested above.
describe("the pages use them", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  it("checkout success page", () => {
    const src = read("src/app/(public)/enroll/[slug]/checkout/success/page.tsx");
    expect(src).toContain("accountTicketCountOf(data)");
    expect(src).toContain("<OpenMyTickets");
    // Headline counts page tickets plus account tickets.
    expect(src).toContain("const orderIssued = ticketReady || accountTickets > 0;");
  });

  it("payment page", () => {
    const src = read("src/app/(public)/enroll/payment/[ref]/page.tsx");
    expect(src).toContain("accountTicketCountOf(d)");
    expect(src).toContain("orderTicketsMissing(");
    expect(src).toContain("<OpenMyTickets");
  });
});
