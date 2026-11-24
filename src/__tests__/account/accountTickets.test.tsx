import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountTicket } from "@/app/api/me/tickets/route";
import {
  TicketListView,
  eventDateLabel,
  groupByEvent,
  readTicketList,
  signInHref,
  type TicketListState,
} from "@/app/(public)/account/tickets/TicketList";
import {
  LiveTicketView,
  secondsLeftAt,
  shouldShowHomeScreenHint,
  type LiveTicketState,
} from "@/app/(public)/account/tickets/[id]/LiveTicket";

// ─── /account/tickets and /account/tickets/[id] (plan Task 8) ───────────────
// Effects (fetch, IndexedDB, the 15 s timer) don't run under react-dom/server,
// so each page's view is rendered per state. The k2 round trip is in
// src/__tests__/tickets/deviceKey.test.ts.

const MYANMAR = /[က-႟]/;
const noop = () => {};

function ticket(over: Partial<AccountTicket> = {}): AccountTicket {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    status: "valid",
    eventId: "intake-1",
    eventName: "Sky Festival",
    tier: "VIP",
    seatNo: 1,
    attendeeName: null,
    eventDate: "2026-12-20",
    endDate: null,
    bound: false,
    role: "leader",
    sharedWith: null,
    leaderEmail: null,
    linkOpen: false,
    canShare: false,
    canGiveBack: false,
    shareClosesAt: null,
    ...over,
  };
}

const renderList = (state: TicketListState) => renderToStaticMarkup(<TicketListView state={state} onRetry={noop} />);

describe("TicketListView", () => {
  it("loading, in both languages", () => {
    const html = renderList({ kind: "loading" });
    expect(html).toContain("Loading");
    expect(html).toMatch(MYANMAR);
  });

  it("signed out: a Sign in button back to this page", () => {
    const html = renderList({ kind: "signedOut" });
    expect(html).toContain('href="/account?next=%2Faccount%2Ftickets"');
    expect(html).toContain("Sign in");
  });

  it("error: Try again", () => {
    const html = renderList({ kind: "error" });
    expect(html).toContain("Try again");
    expect(html).toContain('role="alert"');
  });

  it("empty: the no-tickets text", () => {
    const html = renderList({ kind: "list", tickets: [] });
    expect(html).toContain("No account tickets for this event site.");
    expect(html).toMatch(MYANMAR);
  });

  it("groups by event, each valid ticket linking to its page", () => {
    const html = renderList({
      kind: "list",
      tickets: [
        ticket({ id: "a1", seatNo: 1, attendeeName: "Ko Aung" }),
        ticket({ id: "a2", seatNo: 2, bound: true }),
        ticket({ id: "b1", eventId: "intake-2", eventName: "Beats Run" }),
      ],
    });
    expect(html.match(/<h2[^>]*>/g)).toHaveLength(2);
    expect(html.indexOf("Sky Festival")).toBeLessThan(html.indexOf("Beats Run"));
    expect(html).toContain('href="/account/tickets/a1"');
    expect(html).toContain('href="/account/tickets/a2"');
    expect(html).toContain('href="/account/tickets/b1"');
    expect(html).toContain("Ko Aung");
    expect(html).toContain("20 Dec 2026");
    expect(html).toContain("Phone linked");
  });

  it("a void ticket shows Cancelled and no link", () => {
    const html = renderList({ kind: "list", tickets: [ticket({ id: "v1", status: "void", bound: true })] });
    expect(html).toContain("Cancelled");
    expect(html).not.toContain("/account/tickets/v1");
    expect(html).not.toContain("Phone linked");
  });

  it("links back to /account", () => {
    expect(renderList({ kind: "loading" })).toContain('href="/account"');
  });
});

describe("list helpers", () => {
  it("eventDateLabel: single day, multi-day, same day twice, none", () => {
    expect(eventDateLabel("2026-12-20", null)).toBe("20 Dec 2026");
    expect(eventDateLabel("2026-12-20", "2026-12-21")).toBe("20 Dec 2026 – 21 Dec 2026");
    expect(eventDateLabel("2026-12-20", "2026-12-20")).toBe("20 Dec 2026");
    expect(eventDateLabel(null, "2026-12-21")).toBeNull();
  });

  it("groupByEvent keeps two same-named events apart", () => {
    const groups = groupByEvent([ticket({ id: "x" }), ticket({ id: "y", eventId: "intake-2" })]);
    expect(groups.map((g) => g.tickets.map((t) => t.id))).toEqual([["x"], ["y"]]);
  });

  it("signInHref encodes next", () => {
    expect(signInHref("/account/tickets/abc")).toBe("/account?next=%2Faccount%2Ftickets%2Fabc");
  });

  it("readTicketList: the array, or null for anything malformed", async () => {
    expect(await readTicketList(new Response(JSON.stringify({ tickets: [ticket()] })))).toHaveLength(1);
    expect(await readTicketList(new Response(JSON.stringify({ tickets: "x" })))).toBeNull();
    expect(await readTicketList(new Response("not json"))).toBeNull();
  });
});

const ID = "11111111-2222-4333-8444-555555555555";
const QR = "data:image/png;base64,iVBORw0KGgo=";
const renderLive = (state: LiveTicketState) =>
  renderToStaticMarkup(<LiveTicketView ticketId={ID} state={state} onRetry={noop} />);

function ready(over: Partial<Extract<LiveTicketState, { kind: "ready" }>> = {}): LiveTicketState {
  return {
    kind: "ready",
    email: "leader@example.test",
    ticket: ticket({ attendeeName: "Ko Aung", endDate: "2026-12-21" }),
    qrDataUrl: QR,
    secondsLeft: 12,
    notice: null,
    showHomeScreenHint: false,
    ...over,
  };
}

describe("LiveTicketView", () => {
  it("ready: the QR as an image at least 240 px wide, with event, tier, seat, attendee and email", () => {
    const html = renderLive(ready());
    expect(html).toMatch(new RegExp(`<img[^>]+src="${QR.replace(/[+/=.]/g, "\\$&")}"`));
    expect(html).toContain("min-w-[240px]");
    expect(html).toMatch(/<img[^>]+width="300"/);
    expect(html).toContain("Sky Festival");
    expect(html).toContain("20 Dec 2026 – 21 Dec 2026");
    expect(html).toContain("VIP");
    expect(html).toContain("Ticket 1");
    expect(html).toContain("Ko Aung");
    expect(html).toContain("leader@example.test");
  });

  it("ready: a visible countdown and the keep-open notice in both languages", () => {
    const html = renderLive(ready({ secondsLeft: 7 }));
    expect(html).toContain("QR changes in 7s");
    expect(html).toContain("Open this page before you arrive and keep it open.");
    expect(html).toContain("ပွဲသို့ မရောက်မီ");
  });

  it("ready without a QR yet: a placeholder, no image", () => {
    const html = renderLive(ready({ qrDataUrl: null }));
    expect(html).not.toContain("<img");
  });

  it("ready without details: still shows the QR", () => {
    const html = renderLive(ready({ ticket: null }));
    expect(html).toContain("<img");
    expect(html).not.toContain("Sky Festival");
  });

  it("stale: the couldn't-refresh note", () => {
    expect(renderLive(ready({ notice: "stale" }))).toContain("Couldn&#x27;t refresh; showing your saved ticket.");
    expect(renderLive(ready())).not.toContain("Couldn&#x27;t refresh");
  });

  it("the Home Screen hint only when asked", () => {
    expect(renderLive(ready({ showHomeScreenHint: true }))).toContain("Add to Home Screen");
    expect(renderLive(ready())).not.toContain("Add to Home Screen");
  });

  it("the Home Screen hint says to open the page in Safari first (in-app webviews can't add it), in both languages", () => {
    const html = renderLive(ready({ showHomeScreenHint: true }));
    expect(html).toContain("open this page in Safari first");
    expect(html).toContain("Safari တွင် ဦးစွာ ဖွင့်ပါ");
  });

  it("signed out: Sign in, with next set to this ticket", () => {
    const html = renderLive({ kind: "signedOut" });
    expect(html).toContain(`href="/account?next=%2Faccount%2Ftickets%2F${ID}"`);
  });

  it("not available on this account", () => {
    const html = renderLive({ kind: "notAvailable" });
    expect(html).toContain("This ticket isn&#x27;t available on this account.");
    expect(html).not.toContain("<img");
  });

  it("error: Try again", () => {
    const html = renderLive({ kind: "error" });
    expect(html).toContain("Try again");
    expect(html).toContain('role="alert"');
  });

  it("no storage: says why", () => {
    expect(renderLive({ kind: "noStorage" })).toContain("private browsing");
  });

  it("loading, and a link back to the list", () => {
    const html = renderLive({ kind: "loading" });
    expect(html).toMatch(MYANMAR);
    expect(html).toContain('href="/account/tickets"');
  });
});

describe("live helpers", () => {
  it("secondsLeftAt counts down to the next 15-s boundary of server time", () => {
    expect(secondsLeftAt(1_800_000_000)).toBe(15); // 1_800_000_000 % 15 === 0
    expect(secondsLeftAt(1_800_000_000.9)).toBe(15);
    expect(secondsLeftAt(1_800_000_001)).toBe(14);
    expect(secondsLeftAt(1_800_000_014)).toBe(1);
  });

  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15";

  it("shouldShowHomeScreenHint: iOS in the browser only", () => {
    expect(shouldShowHomeScreenHint({ userAgent: IPHONE })).toBe(true);
    expect(shouldShowHomeScreenHint({ userAgent: IPHONE, standalone: true })).toBe(false);
    expect(shouldShowHomeScreenHint({ userAgent: ANDROID })).toBe(false);
    // iPadOS reports a Mac; touch points give it away.
    expect(shouldShowHomeScreenHint({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(shouldShowHomeScreenHint({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
  });
});

describe("secrets stay out of logs and the page", () => {
  const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8");
  const files = [
    "src/lib/tickets/deviceKey.ts",
    "src/lib/tickets/liveClock.ts",
    "src/app/(public)/account/tickets/[id]/liveTicketFlow.ts",
    "src/app/(public)/account/tickets/TicketList.tsx",
    "src/app/(public)/account/tickets/[id]/LiveTicket.tsx",
    "src/app/api/me/tickets/route.ts",
  ];

  it.each(files)("%s has no console.log / console.warn / console.debug", (f) => {
    expect(read(f)).not.toMatch(/console\.(log|warn|info|debug)\(/);
  });

  it("the ticket page renders the QR text only as an image", () => {
    const src = read("src/app/(public)/account/tickets/[id]/LiveTicket.tsx");
    // The k2 text goes straight from k2Text into QRCode.toDataURL; no state holds it.
    expect(src).toMatch(/k2TextAt\(session\.pair, session, qrTs\(slot\)\)\s*\.then\(\(text\) => QRCode\.toDataURL\(text,/);
    expect(src).not.toMatch(/set\w*\(text\)/);
    expect(src).toContain('errorCorrectionLevel: "L"');
  });
});
