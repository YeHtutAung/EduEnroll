import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountTicket } from "@/app/api/me/tickets/route";
import { shareCutoffAt } from "@/lib/tickets/exp";
import SeatSharing, {
  SeatSharingView,
  initialSharingUi,
  shareClosesLabel,
  type SharingUi,
} from "@/app/(public)/account/tickets/[id]/SeatSharing";

// ─── Seat sharing on the ticket page (plan 4 Task 11) ──────────────────────
// Static render, as accountTickets.test.tsx does: effects and clicks don't run
// under react-dom/server, so each UI state is rendered directly.

const MYANMAR = /[က-႟]/;
const noop = () => {};
const URL_SECRET = "https://skyfestival.example.test/t/claim#AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const CUTOFF = shareCutoffAt("2026-12-20")!;

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
    bound: true,
    role: "leader",
    sharedWith: null,
    leaderEmail: null,
    linkOpen: false,
    canShare: false,
    canGiveBack: false,
    shareClosesAt: CUTOFF,
    ...over,
  };
}

const actions = {
  onShare: noop,
  onCancelLink: noop,
  onCopy: noop,
  onAskGiveBack: noop,
  onConfirmGiveBack: noop,
  onKeep: noop,
};

const render = (t: AccountTicket, ui: Partial<SharingUi> = {}) =>
  renderToStaticMarkup(<SeatSharingView ticket={t} ui={{ ...initialSharingUi(t), ...ui }} {...actions} />);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shareClosesLabel", () => {
  it("formats the cutoff in Asia/Yangon (midnight the day before the event)", () => {
    // 2026-12-20 event → sharing closes 19 Dec 2026 00:00 Yangon (18 Dec 17:30 UTC).
    expect(CUTOFF).toBe(Date.UTC(2026, 11, 18, 17, 30) / 1000);
    expect(shareClosesLabel(CUTOFF)).toBe("19 Dec 2026, 00:00");
  });
});

describe("SeatSharingView: leader", () => {
  it("canShare: Share this seat and when sharing closes, in both languages", () => {
    const html = render(ticket({ canShare: true }));
    expect(html).toContain("Share this seat");
    expect(html).toContain("Sharing closes 19 Dec 2026, 00:00");
    expect(html).toMatch(MYANMAR);
    expect(html).not.toContain("Link sent");
    expect(html).not.toContain("Cancel link");
    expect(html).not.toContain("<input");
  });

  it("after a share: the URL in a read-only field with Copy, and Cancel link", () => {
    const html = render(ticket({ canShare: true }), { url: URL_SECRET, linkOpen: true });
    expect(html).toMatch(/<input[^>]+readOnly=""|<input[^>]+readonly=""/);
    expect(html).toContain(`value="${URL_SECRET}"`);
    expect(html).toContain("Copy");
    expect(html).toContain("Cancel link");
  });

  it("an open link from an earlier visit: Link sent and Cancel link, but never a URL", () => {
    const html = render(ticket({ canShare: true, linkOpen: true }));
    expect(html).toContain("Link sent");
    expect(html).toContain("Cancel link");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("/t/claim");
  });

  it("copied: says so", () => {
    expect(render(ticket({ canShare: true }), { url: URL_SECRET, linkOpen: true, copied: true })).toContain("Copied");
  });

  it("errors: 429 → Too many tries; anything else → Something went wrong", () => {
    expect(render(ticket({ canShare: true }), { error: "limited" })).toContain("Too many tries. Try again later.");
    expect(render(ticket({ canShare: true }), { error: "generic" })).toContain("Something went wrong");
  });

  it("busy: the buttons are disabled", () => {
    const html = render(ticket({ canShare: true }), { busy: true });
    expect(html).toMatch(/<button[^>]+disabled=""/);
  });
});

describe("SeatSharingView: holder", () => {
  const holder = ticket({ role: "holder", leaderEmail: "k***@gmail.com", canGiveBack: true });

  it("canGiveBack: Give back to the leader", () => {
    const html = render(holder);
    expect(html).toContain("Give back to k***@gmail.com");
    expect(html).toMatch(MYANMAR);
    expect(html).not.toContain("Share this seat");
    expect(html).toContain("Sharing closes 19 Dec 2026, 00:00");
  });

  it("asks first: Give this seat back? Your QR stops working.", () => {
    const html = render(holder, { confirmingGiveBack: true });
    expect(html).toContain("Give this seat back? Your QR stops working.");
    expect(html).toContain("Keep it");
  });
});

describe("SeatSharingView: closed or void", () => {
  it("neither flag on a valid seat: Sharing has closed for this event.", () => {
    const html = render(ticket());
    expect(html).toContain("Sharing has closed for this event.");
    expect(html).not.toContain("Share this seat");
    expect(html).not.toContain("Give back");
    expect(html).not.toContain("<button");
  });

  it("a holder whose seat can't be given back any more: closed too", () => {
    expect(render(ticket({ role: "holder", leaderEmail: "k***@gmail.com" }))).toContain(
      "Sharing has closed for this event.",
    );
  });

  it("a void seat: nothing at all", () => {
    expect(render(ticket({ status: "void", canShare: true, linkOpen: true }))).toBe("");
  });
});

describe("the share URL stays out of storage, logs and the page", () => {
  it("rendering a share URL writes nothing to localStorage or sessionStorage", () => {
    const local = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    const session = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    render(ticket({ canShare: true }), { url: URL_SECRET, linkOpen: true });
    renderToStaticMarkup(<SeatSharing ticket={ticket({ canShare: true })} />);
    for (const s of [local, session]) {
      expect(s.setItem).not.toHaveBeenCalled();
      expect(s.getItem).not.toHaveBeenCalled();
    }
  });

  it("the source never touches storage, the page URL or a log", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/app/(public)/account/tickets/[id]/SeatSharing.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(src).not.toMatch(/history\.(push|replace)State|location\.hash/);
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/dataLayer|gtag|fbq/);
  });

  it("the initial state has no URL", () => {
    expect(initialSharingUi(ticket({ canShare: true, linkOpen: true })).url).toBeNull();
  });
});
