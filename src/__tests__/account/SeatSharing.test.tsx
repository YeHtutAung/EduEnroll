import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountTicket } from "@/app/api/me/tickets/route";
import { shareCutoffAt } from "@/lib/tickets/exp";
import SeatSharing, {
  SeatSharingView,
  initialSharingUi,
  sharingRequests,
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

const BEFORE_CUTOFF = CUTOFF - 3600;
const AFTER_CUTOFF = CUTOFF + 1;

const render = (t: AccountTicket, ui: Partial<SharingUi> = {}, now = BEFORE_CUTOFF) =>
  renderToStaticMarkup(
    <SeatSharingView ticket={t} ui={{ ...initialSharingUi(t), ...ui }} now={now} {...actions} />,
  );

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
  it("neither flag once the cutoff has passed: Sharing has closed for this event.", () => {
    const html = render(ticket(), {}, AFTER_CUTOFF);
    expect(html).toContain("Sharing has closed for this event.");
    expect(html).not.toContain("Share this seat");
    expect(html).not.toContain("Give back");
    expect(html).not.toContain("<button");
  });

  it("neither flag before the cutoff (an admitted seat): nothing at all", () => {
    expect(render(ticket(), {}, BEFORE_CUTOFF)).toBe("");
  });

  it("a holder whose seat can't be given back (the leader is gone), before the cutoff: nothing", () => {
    expect(render(ticket({ role: "holder", leaderEmail: "k***@gmail.com" }), {}, BEFORE_CUTOFF)).toBe("");
  });

  it("a holder after the cutoff: closed", () => {
    expect(render(ticket({ role: "holder", leaderEmail: "k***@gmail.com" }), {}, AFTER_CUTOFF)).toContain(
      "Sharing has closed for this event.",
    );
  });

  it("no cutoff known: nothing", () => {
    expect(render(ticket({ shareClosesAt: null }), {}, AFTER_CUTOFF)).toBe("");
  });

  it("a void seat: nothing at all", () => {
    expect(render(ticket({ status: "void", canShare: true, linkOpen: true }))).toBe("");
  });

  it("after a 404: a short line, in both languages, and no buttons", () => {
    for (const t of [ticket({ canShare: true, linkOpen: true }), ticket({ role: "holder", canGiveBack: true })]) {
      const html = render(t, { gone: true, linkOpen: false });
      expect(html).toContain("This seat can&#x27;t be shared or given back any more.");
      expect(html).toMatch(MYANMAR);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("Something went wrong");
    }
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

// No DOM in this suite (vitest runs in node, without jsdom or Testing
// Library), so the default export's request handlers are driven directly.
describe("sharingRequests", () => {
  function harness(t: AccountTicket = ticket({ canShare: true })) {
    let ui = initialSharingUi(t);
    const goTo = vi.fn();
    const reqs = sharingRequests(t.id, (next) => (ui = { ...ui, ...next }), goTo);
    return { reqs, goTo, ui: () => ui };
  }

  const respond = (status: number, body: unknown = null) =>
    vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status }));

  it("share: the URL lands in the field, and neither storage is written", async () => {
    const local = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    const session = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    const fetchMock = respond(200, { url: URL_SECRET, expiresAt: CUTOFF });
    vi.stubGlobal("fetch", fetchMock);

    const h = harness();
    await h.reqs.share();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/tickets/11111111-2222-4333-8444-555555555555/share",
      expect.objectContaining({ method: "POST" }),
    );
    expect(h.ui()).toMatchObject({ url: URL_SECRET, linkOpen: true, busy: false, error: null });
    for (const s of [local, session]) {
      expect(s.setItem).not.toHaveBeenCalled();
      expect(s.getItem).not.toHaveBeenCalled();
    }
    const html = renderToStaticMarkup(
      <SeatSharingView ticket={ticket({ canShare: true })} ui={h.ui()} now={BEFORE_CUTOFF} {...actions} />,
    );
    expect(html).toContain(`value="${URL_SECRET}"`);
  });

  it("share: 429 → limited; 500 → generic, buttons still there", async () => {
    vi.stubGlobal("fetch", respond(429));
    const a = harness();
    await a.reqs.share();
    expect(a.ui()).toMatchObject({ error: "limited", busy: false, gone: false });

    vi.stubGlobal("fetch", respond(500));
    const b = harness();
    await b.reqs.share();
    expect(b.ui()).toMatchObject({ error: "generic", busy: false, gone: false });
  });

  it("a 404 from share, cancel or give-back switches to the gone state", async () => {
    vi.stubGlobal("fetch", respond(404));
    const share = harness();
    await share.reqs.share();
    expect(share.ui()).toMatchObject({ gone: true, busy: false, error: null, url: null, linkOpen: false });

    const cancel = harness(ticket({ canShare: true, linkOpen: true }));
    await cancel.reqs.cancelLink();
    expect(cancel.ui()).toMatchObject({ gone: true, busy: false, error: null, linkOpen: false });

    const giveBack = harness(ticket({ role: "holder", canGiveBack: true }));
    await giveBack.reqs.giveBack();
    expect(giveBack.ui()).toMatchObject({ gone: true, busy: false, error: null, confirmingGiveBack: false });
    expect(giveBack.goTo).not.toHaveBeenCalled();
  });

  it("give back: 200 goes to /account/tickets", async () => {
    vi.stubGlobal("fetch", respond(200, { ok: true }));
    const h = harness(ticket({ role: "holder", canGiveBack: true }));
    await h.reqs.giveBack();
    expect(h.goTo).toHaveBeenCalledWith("/account/tickets");
  });
});
