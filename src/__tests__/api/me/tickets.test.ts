import { describe, it, expect, vi, beforeEach } from "vitest";
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
let devicesResult: Result;
const calls: Record<string, unknown[][]> = {};
const from = vi.fn((table: string) => {
  calls[table] = calls[table] ?? [];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "order"]) {
    q[m] = vi.fn((...a: unknown[]) => {
      calls[table].push([m, ...a]);
      return q;
    });
  }
  q.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(table === "tickets" ? ticketsResult : devicesResult).then(resolve, reject);
  return q;
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from }) }));

import { GET, dynamic } from "@/app/api/me/tickets/route";

const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_TENANT = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BUYER = "99999999-8888-4777-8666-555555555555";
const OTHER_BUYER = "77777777-8888-4777-8666-555555555555";

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
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(calls)) delete calls[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
  requireBuyer.mockResolvedValue({ buyerId: BUYER, email: "leader@example.test", isReviewer: false, sessionId: "s1" });
  resolveTenantId.mockResolvedValue(TENANT);
  ticketsResult = { data: [row("t1")], error: null };
  devicesResult = { data: [], error: null };
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
