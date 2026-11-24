import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

// ─── GET /api/me/tickets: the buyer's account tickets on this site (Task 8) ──
// The route filters in SQL and again on the rows it gets back, so these tests
// hand it rows the SQL filters would have dropped and check none survive.

const requireBuyer = vi.fn();
const resolveTenantId = vi.fn();
vi.mock("@/lib/api", () => ({
  requireBuyer: () => requireBuyer(),
  resolveTenantId: () => resolveTenantId(),
}));

type Result = { data: unknown; error: unknown };
let ticketsResult: Result;
let heldResult: Result;
let devicesResult: Result;
let linksResult: Result;
let profilesResult: Result;
const calls: Record<string, unknown[][]> = {};
/** Each query's own calls, so the two ticket queries can be told apart. */
const queries: Array<{ table: string; calls: unknown[][] }> = [];
const from = vi.fn((table: string) => {
  calls[table] = calls[table] ?? [];
  const own: unknown[][] = [];
  queries.push({ table, calls: own });
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "order"]) {
    q[m] = vi.fn((...a: unknown[]) => {
      calls[table].push([m, ...a]);
      own.push([m, ...a]);
      return q;
    });
  }
  const result = (): Result => {
    if (table === "tickets") {
      return own.some((c) => c[0] === "eq" && c[1] === "holder_buyer_id") ? heldResult : ticketsResult;
    }
    if (table === "ticket_devices") return devicesResult;
    if (table === "ticket_share_links") return linksResult;
    if (table === "buyer_profiles") return profilesResult;
    throw new Error(`unexpected table ${table}`);
  };
  q.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return q;
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from }) }));

import { GET, dynamic } from "@/app/api/me/tickets/route";
import { shareCutoffAt } from "@/lib/tickets/exp";

const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_TENANT = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BUYER = "99999999-8888-4777-8666-555555555555";
const OTHER_BUYER = "77777777-8888-4777-8666-555555555555";
const FRIEND = "66666666-8888-4777-8666-555555555555";
/** Before the 2026-12-20 event's share cutoff (2026-12-18 17:30 UTC). */
const NOW = new Date("2026-11-23T00:00:00Z");

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: "valid",
    tier: "VIP",
    seat_no: 1,
    attendee: null,
    intake_id: "intake-1",
    tenant_id: TENANT,
    enrollments: { buyer_id: BUYER, status: "confirmed" },
    intakes: { name: "Sky Festival", ticket_protection: true },
    classes: { event_date: "2026-12-20", end_time: "2026-12-21" },
    holder_buyer_id: null,
    first_scan_at: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(calls)) delete calls[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
  requireBuyer.mockResolvedValue({ buyerId: BUYER, email: "leader@example.test", isReviewer: false, sessionId: "s1" });
  resolveTenantId.mockResolvedValue(TENANT);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  queries.length = 0;
  ticketsResult = { data: [row("t1")], error: null };
  heldResult = { data: [], error: null };
  devicesResult = { data: [], error: null };
  linksResult = { data: [], error: null };
  profilesResult = { data: [], error: null };
});

afterEach(() => {
  vi.useRealTimers();
});

async function ok() {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as { tickets: Array<Record<string, unknown>> };
}

const ids = (body: { tickets: Array<Record<string, unknown>> }) => body.tickets.map((t) => t.id);

describe("GET /api/me/tickets", () => {
  it("is force-dynamic", () => expect(dynamic).toBe("force-dynamic"));

  it("not signed in → requireBuyer's 401, no-store, no query", async () => {
    requireBuyer.mockResolvedValue(
      NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in required." } }, { status: 401 }),
    );
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(from).not.toHaveBeenCalled();
  });

  it("an unknown tenant → resolveTenantId's error, no query", async () => {
    resolveTenantId.mockResolvedValue(NextResponse.json({ error: "Not Found" }, { status: 404 }));
    const res = await GET();
    expect(res.status).toBe(404);
    expect(from).not.toHaveBeenCalled();
  });

  it("filters in SQL by this tenant, this buyer, confirmed orders and protected intakes", async () => {
    await ok();
    const eqs = calls.tickets.filter((c) => c[0] === "eq").map((c) => c.slice(1));
    expect(eqs).toEqual(
      expect.arrayContaining([
        ["tenant_id", TENANT],
        ["enrollments.buyer_id", BUYER],
        ["enrollments.status", "confirmed"],
        ["intakes.ticket_protection", true],
      ]),
    );
  });

  it("returns the ticket in the documented shape", async () => {
    ticketsResult = { data: [row("t1", { seat_no: 2, attendee: { label: "Ko Aung" } })], error: null };
    devicesResult = { data: [{ ticket_id: "t1" }], error: null };
    expect((await ok()).tickets).toEqual([
      {
        id: "t1",
        status: "valid",
        eventId: "intake-1",
        eventName: "Sky Festival",
        tier: "VIP",
        seatNo: 2,
        attendeeName: "Ko Aung",
        eventDate: "2026-12-20",
        endDate: "2026-12-21",
        bound: true,
        role: "leader",
        sharedWith: null,
        leaderEmail: null,
        linkOpen: false,
        canShare: true,
        canGiveBack: false,
        shareClosesAt: shareCutoffAt("2026-12-20"),
      },
    ]);
  });

  it("another tenant's order isn't listed", async () => {
    ticketsResult = { data: [row("t1"), row("t2", { tenant_id: OTHER_TENANT })], error: null };
    expect(ids(await ok())).toEqual(["t1"]);
  });

  it("another buyer's order isn't listed", async () => {
    ticketsResult = {
      data: [row("t1"), row("t2", { enrollments: { buyer_id: OTHER_BUYER, status: "confirmed" } })],
      error: null,
    };
    expect(ids(await ok())).toEqual(["t1"]);
  });

  it("an order with no buyer isn't listed", async () => {
    ticketsResult = { data: [row("t1", { enrollments: { buyer_id: null, status: "confirmed" } })], error: null };
    expect(ids(await ok())).toEqual([]);
  });

  it("an unconfirmed order isn't listed", async () => {
    ticketsResult = {
      data: [row("t1"), row("t2", { enrollments: { buyer_id: BUYER, status: "payment_submitted" } })],
      error: null,
    };
    expect(ids(await ok())).toEqual(["t1"]);
  });

  it("an unprotected order isn't listed", async () => {
    ticketsResult = {
      data: [row("t1"), row("t2", { intakes: { name: "Open Day", ticket_protection: false } })],
      error: null,
    };
    expect(ids(await ok())).toEqual(["t1"]);
  });

  it("a void ticket is listed as void", async () => {
    ticketsResult = { data: [row("t1", { status: "void" })], error: null };
    expect((await ok()).tickets[0]).toMatchObject({ id: "t1", status: "void" });
  });

  it("bound reads active device rows only, in one query over the listed ids", async () => {
    ticketsResult = { data: [row("t1"), row("t2", { seat_no: 2 })], error: null };
    devicesResult = { data: [{ ticket_id: "t2" }], error: null };
    const body = await ok();
    expect(body.tickets.map((t) => [t.id, t.bound])).toEqual([
      ["t1", false],
      ["t2", true],
    ]);
    expect(from.mock.calls.filter((c) => c[0] === "ticket_devices")).toHaveLength(1);
    expect(calls.ticket_devices).toEqual(
      expect.arrayContaining([
        ["in", "ticket_id", ["t1", "t2"]],
        ["is", "revoked_at", null],
      ]),
    );
  });

  it("no tickets → empty list and no device query", async () => {
    ticketsResult = { data: [], error: null };
    expect((await ok()).tickets).toEqual([]);
    expect(calls.ticket_devices).toBeUndefined();
  });

  it("missing dates and attendee are null", async () => {
    ticketsResult = { data: [row("t1", { classes: null, attendee: { label: 5 } })], error: null };
    expect((await ok()).tickets[0]).toMatchObject({ attendeeName: null, eventDate: null, endDate: null });
  });

  it("sorts by event date, then event, then seat", async () => {
    ticketsResult = {
      data: [
        row("late", { classes: { event_date: "2027-01-05", end_time: null } }),
        row("seat2", { seat_no: 2 }),
        row("seat1", { seat_no: 1 }),
      ],
      error: null,
    };
    expect(ids(await ok())).toEqual(["seat1", "seat2", "late"]);
  });

  it("never returns a token, a QR or a key at any depth", async () => {
    ticketsResult = {
      data: [row("t1", { jwt: "x", qr: "x", token: "x", public_key: "x", attendee: { label: "A", answers: { a: 1 } } })],
      error: null,
    };
    devicesResult = { data: [{ ticket_id: "t1", public_key: "x" }], error: null };
    const res = await GET();
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === "object") {
        for (const [k, inner] of Object.entries(v)) {
          keys.push(k);
          walk(inner);
        }
      }
    };
    walk(await res.json());
    for (const banned of ["jwt", "qr", "token", "public_key", "publicKey", "dk", "answers"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("a ticket read error → 503 SERVER, no-store", async () => {
    ticketsResult = { data: null, error: { code: "XX000" } };
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: { code: "SERVER" } });
  });

  it("a device read error → 503 SERVER (bound must not silently read false)", async () => {
    devicesResult = { data: null, error: { code: "XX000" } };
    const res = await GET();
    expect(res.status).toBe(503);
  });
});

describe("GET /api/me/tickets: seat sharing (plan 4 Task 9)", () => {
  const byId = (body: { tickets: Array<Record<string, unknown>> }) =>
    Object.fromEntries(body.tickets.map((t) => [t.id, t]));
  const ticketQueries = () => queries.filter((q) => q.table === "tickets");
  const held = (id: string, over: Record<string, unknown> = {}) =>
    row(id, { holder_buyer_id: BUYER, enrollments: { buyer_id: OTHER_BUYER, status: "confirmed" }, ...over });

  it("runs a second ticket query for seats this buyer holds, with the same tenant, status and protection filters", async () => {
    await ok();
    const [led, heldQ] = ticketQueries();
    const eqs = (q: { calls: unknown[][] }) => q.calls.filter((c) => c[0] === "eq").map((c) => c.slice(1));
    expect(eqs(led)).toEqual(expect.arrayContaining([["enrollments.buyer_id", BUYER]]));
    expect(eqs(heldQ)).toEqual(
      expect.arrayContaining([
        ["tenant_id", TENANT],
        ["holder_buyer_id", BUYER],
        ["enrollments.status", "confirmed"],
        ["intakes.ticket_protection", true],
      ]),
    );
    expect(eqs(heldQ)).not.toEqual(expect.arrayContaining([["enrollments.buyer_id", BUYER]]));
    for (const q of [led, heldQ]) {
      const select = String(q.calls.find((c) => c[0] === "select")?.[1]);
      expect(select).toContain("holder_buyer_id");
      expect(select).toContain("first_scan_at");
    }
  });

  it("a seat on the buyer's order is role leader; a seat they claimed is role holder with leaderEmail masked", async () => {
    ticketsResult = { data: [row("own")], error: null };
    heldResult = { data: [held("claimed")], error: null };
    profilesResult = { data: [{ id: OTHER_BUYER, email: "leader@example.test" }], error: null };
    const t = byId(await ok());
    expect(t.own).toMatchObject({ role: "leader", leaderEmail: null, sharedWith: null });
    expect(t.claimed).toMatchObject({ role: "holder", leaderEmail: "l***@example.test", sharedWith: null, linkOpen: false });
  });

  it("a leader's seat a friend holds: sharedWith masked, bound false, can't share", async () => {
    ticketsResult = { data: [row("away", { holder_buyer_id: FRIEND })], error: null };
    devicesResult = { data: [{ ticket_id: "away" }], error: null };
    profilesResult = { data: [{ id: FRIEND, email: "friend@example.test" }], error: null };
    const t = byId(await ok());
    expect(t.away).toMatchObject({
      role: "leader",
      sharedWith: "f***@example.test",
      bound: false,
      canShare: false,
      canGiveBack: false,
    });
    // The friend's phone is not the viewer's: no device read for that seat.
    expect(calls.ticket_devices).toBeUndefined();
  });

  it("reads active devices only for seats the buyer holds, and only the buyer's own", async () => {
    ticketsResult = { data: [row("mine"), row("away", { seat_no: 2, holder_buyer_id: FRIEND })], error: null };
    heldResult = { data: [held("claimed")], error: null };
    await ok();
    expect(calls.ticket_devices).toEqual(
      expect.arrayContaining([
        ["in", "ticket_id", expect.arrayContaining(["mine", "claimed"])],
        ["eq", "buyer_id", BUYER],
        ["is", "revoked_at", null],
      ]),
    );
    const listed = calls.ticket_devices.find((c) => c[0] === "in")![2] as string[];
    expect(listed).not.toContain("away");
  });

  it("an open link on a leader's seat → linkOpen true; links are read only for leader-held seats", async () => {
    ticketsResult = { data: [row("open"), row("shut", { seat_no: 2 })], error: null };
    heldResult = { data: [held("claimed")], error: null };
    linksResult = { data: [{ ticket_id: "open", expires_at: "2026-12-18T17:30:00Z" }], error: null };
    const t = byId(await ok());
    expect(t.open.linkOpen).toBe(true);
    expect(t.shut.linkOpen).toBe(false);
    expect(t.claimed.linkOpen).toBe(false);
    expect(calls.ticket_share_links).toEqual(
      expect.arrayContaining([
        ["in", "ticket_id", ["open", "shut"]],
        ["is", "claimed_at", null],
        ["is", "cancelled_at", null],
      ]),
    );
  });

  it("a link follows the live cutoff, not its stored expires_at: open while the seat is movable", async () => {
    // The claim recomputes the cutoff from the class's current event_date, so a
    // stale stored expiry (the event moved later) must not hide an open link.
    linksResult = { data: [{ ticket_id: "t1", expires_at: "2026-11-01T00:00:00Z" }], error: null };
    expect((await ok()).tickets[0].linkOpen).toBe(true);
    const select = String(calls.ticket_share_links.find((c) => c[0] === "select")?.[1]);
    expect(select).not.toContain("expires_at");
  });

  it("an open link on a seat that is no longer movable isn't open", async () => {
    ticketsResult = {
      data: [
        row("admitted", { first_scan_at: "2026-11-20T10:00:00Z" }),
        row("void", { seat_no: 2, status: "void" }),
        row("nodate", { seat_no: 3, classes: null }),
      ],
      error: null,
    };
    linksResult = {
      data: ["admitted", "void", "nodate"].map((id) => ({ ticket_id: id, expires_at: "2026-12-18T17:30:00Z" })),
      error: null,
    };
    const t = byId(await ok());
    for (const id of ["admitted", "void", "nodate"]) expect(t[id].linkOpen).toBe(false);
  });

  it("an open link at the live cutoff isn't open, even if the stored expiry is later", async () => {
    vi.setSystemTime(new Date(shareCutoffAt("2026-12-20")! * 1000));
    linksResult = { data: [{ ticket_id: "t1", expires_at: "2027-01-01T00:00:00Z" }], error: null };
    expect((await ok()).tickets[0].linkOpen).toBe(false);
  });

  it("canShare: leader, valid, not shared, not scanned, before the cutoff", async () => {
    ticketsResult = {
      data: [
        row("yes"),
        row("void", { seat_no: 2, status: "void" }),
        row("scanned", { seat_no: 3, first_scan_at: "2026-11-20T10:00:00Z" }),
        row("shared", { seat_no: 4, holder_buyer_id: FRIEND }),
        row("nodate", { seat_no: 5, classes: null }),
      ],
      error: null,
    };
    const t = byId(await ok());
    expect(t.yes.canShare).toBe(true);
    for (const id of ["void", "scanned", "shared", "nodate"]) expect(t[id].canShare).toBe(false);
  });

  it("canShare and canGiveBack are false at the cutoff", async () => {
    vi.setSystemTime(new Date(shareCutoffAt("2026-12-20")! * 1000));
    ticketsResult = { data: [row("t1")], error: null };
    heldResult = { data: [held("c")], error: null };
    const t = byId(await ok());
    expect(t.t1.canShare).toBe(false);
    expect(t.c.canGiveBack).toBe(false);
  });

  it("canGiveBack: holder, valid, not scanned, before the cutoff, leader live", async () => {
    ticketsResult = { data: [], error: null };
    heldResult = {
      data: [held("yes"), held("void", { seat_no: 2, status: "void" }), held("scanned", { seat_no: 3, first_scan_at: "x" })],
      error: null,
    };
    profilesResult = { data: [{ id: OTHER_BUYER, email: "leader@example.test" }], error: null };
    const t = byId(await ok());
    expect(t.yes).toMatchObject({ canGiveBack: true, canShare: false });
    expect(t.void.canGiveBack).toBe(false);
    expect(t.scanned.canGiveBack).toBe(false);
  });

  it("canGiveBack is false when the order has no leader (give_back_seat refuses buyer_id NULL)", async () => {
    ticketsResult = { data: [], error: null };
    heldResult = { data: [held("orphan", { enrollments: { buyer_id: null, status: "confirmed" } })], error: null };
    profilesResult = { data: [{ id: OTHER_BUYER, email: "leader@example.test" }], error: null };
    const t = byId(await ok());
    expect(t.orphan).toMatchObject({ role: "holder", canGiveBack: false });
  });

  it("canGiveBack is false when the leader's profile isn't live (deleted or missing)", async () => {
    ticketsResult = { data: [], error: null };
    heldResult = { data: [held("c")], error: null };
    profilesResult = { data: [], error: null };
    const t = byId(await ok());
    expect(t.c).toMatchObject({ role: "holder", canGiveBack: false });
  });

  it("shareClosesAt comes from shareCutoffAt(eventDate); null with no date", async () => {
    ticketsResult = { data: [row("d"), row("n", { seat_no: 2, classes: null })], error: null };
    const t = byId(await ok());
    expect(t.d.shareClosesAt).toBe(shareCutoffAt("2026-12-20"));
    expect(t.n.shareClosesAt).toBeNull();
  });

  it("a held seat of another tenant, another holder, an unconfirmed order or an unprotected intake isn't listed", async () => {
    ticketsResult = { data: [], error: null };
    heldResult = {
      data: [
        held("ok"),
        held("tenant", { tenant_id: OTHER_TENANT }),
        held("holder", { holder_buyer_id: FRIEND }),
        held("unconfirmed", { enrollments: { buyer_id: OTHER_BUYER, status: "payment_submitted" } }),
        held("open", { intakes: { name: "Open Day", ticket_protection: false } }),
      ],
      error: null,
    };
    expect(ids(await ok())).toEqual(["ok"]);
  });

  it("a seat returned by both queries is listed once", async () => {
    const both = row("t1", { holder_buyer_id: BUYER });
    ticketsResult = { data: [both], error: null };
    heldResult = { data: [both], error: null };
    expect(ids(await ok())).toEqual(["t1"]);
  });

  it("a deleted or missing profile shows ***; profiles are read once, live only", async () => {
    ticketsResult = { data: [row("away", { holder_buyer_id: FRIEND })], error: null };
    heldResult = { data: [held("c")], error: null };
    profilesResult = { data: [], error: null };
    const t = byId(await ok());
    expect(t.away.sharedWith).toBe("***");
    expect(t.c.leaderEmail).toBe("***");
    expect(from.mock.calls.filter((c) => c[0] === "buyer_profiles")).toHaveLength(1);
    expect(calls.buyer_profiles).toEqual(
      expect.arrayContaining([
        ["in", "id", expect.arrayContaining([FRIEND, OTHER_BUYER])],
        ["is", "deleted_at", null],
      ]),
    );
  });

  it("never returns a full email address or another buyer's id", async () => {
    ticketsResult = { data: [row("away", { holder_buyer_id: FRIEND })], error: null };
    heldResult = { data: [held("c")], error: null };
    profilesResult = {
      data: [
        { id: FRIEND, email: "friend@example.test" },
        { id: OTHER_BUYER, email: "leader@example.test" },
      ],
      error: null,
    };
    const text = JSON.stringify(await ok());
    expect(text).not.toContain("friend@");
    expect(text).not.toContain("leader@");
    expect(text).not.toContain(FRIEND);
    expect(text).not.toContain(OTHER_BUYER);
  });

  it.each([
    ["held tickets", () => (heldResult = { data: null, error: { code: "XX000" } })],
    ["links", () => (linksResult = { data: null, error: { code: "XX000" } })],
    [
      "profiles",
      () => {
        ticketsResult = { data: [row("away", { holder_buyer_id: FRIEND })], error: null };
        profilesResult = { data: null, error: { code: "XX000" } };
      },
    ],
  ])("a %s read error → 503", async (_k, setup) => {
    setup();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
