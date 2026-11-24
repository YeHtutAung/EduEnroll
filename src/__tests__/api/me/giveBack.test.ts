import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ─── POST /api/me/tickets/[id]/give-back (plan 4 Task 8) ────────────────────

const requireBuyer = vi.fn();
const resolveTenantId = vi.fn();
vi.mock("@/lib/api", () => ({
  requireBuyer: () => requireBuyer(),
  resolveTenantId: () => resolveTenantId(),
}));

const consumeRateLimit = vi.fn();
vi.mock("@/server/buyers/rateLimit", () => ({
  consumeRateLimit: (...a: unknown[]) => consumeRateLimit(...a),
}));

const sendEmail = vi.fn();
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmail: (...a: unknown[]) => sendEmail(...a) };
});

type Result = { data: unknown; error: unknown };
let reads: Record<string, Result>;
let rpcResult: Result;
const calls: Record<string, unknown[][]> = {};
const rpc = vi.fn(async (...args: unknown[]) => {
  void args;
  return rpcResult;
});
const from = vi.fn((table: string) => {
  calls[table] = calls[table] ?? [];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in"]) {
    q[m] = vi.fn((...a: unknown[]) => {
      calls[table].push([m, ...a]);
      return q;
    });
  }
  q.maybeSingle = vi.fn(async () => reads[table]);
  q.single = vi.fn(async () => reads[table]);
  return q;
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from, rpc }) }));

import { POST, dynamic } from "@/app/api/me/tickets/[id]/give-back/route";
import { seatGivenBackEmail } from "@/lib/email";

const TICKET = "11111111-2222-4333-8444-555555555555";
const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HOLDER = "99999999-8888-4777-8666-555555555555";
const LEADER = "77777777-8888-4777-8666-555555555555";

function post(opts: { id?: string; headers?: Record<string, string>; body?: string } = {}) {
  const id = opts.id ?? TICKET;
  const req = new Request(`https://sky.kuunyi.com/api/me/tickets/${id}/give-back`, {
    method: "POST",
    body: opts.body,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
  });
  return POST(req, { params: { id } });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toMatchObject({ error: { code } });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(calls)) delete calls[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  requireBuyer.mockResolvedValue({ buyerId: HOLDER, email: "friend@example.test", isReviewer: false, sessionId: "s1" });
  resolveTenantId.mockResolvedValue(TENANT);
  consumeRateLimit.mockResolvedValue("ok");
  sendEmail.mockResolvedValue(true);
  rpcResult = { data: [{ result: "given_back", leader_id: LEADER }], error: null };
  reads = {
    buyer_profiles: { data: { email: "leader@example.test" }, error: null },
    tickets: { data: { tier: "VIP" }, error: null },
    tenants: { data: { name: "Sky Festival", logo_url: "https://cdn.example/logo.png" }, error: null },
  };
});

describe("guards", () => {
  it("is force-dynamic", () => expect(dynamic).toBe("force-dynamic"));

  it("cross-site → 403 and no Auth call", async () => {
    await expectError(await post({ headers: { "sec-fetch-site": "cross-site" } }), 403, "FORBIDDEN");
    expect(requireBuyer).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("signed out → 401, no RPC", async () => {
    requireBuyer.mockResolvedValue(
      NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in required." } }, { status: 401 }),
    );
    await expectError(await post(), 401, "UNAUTHENTICATED");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("malformed id → 404, no RPC", async () => {
    await expectError(await post({ id: "x" }), 404, "NOT_FOUND");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("limited → 429, no RPC", async () => {
    consumeRateLimit.mockResolvedValue("limited");
    await expectError(await post(), 429, "RATE_LIMITED");
    expect(rpc).not.toHaveBeenCalled();
    expect(consumeRateLimit.mock.calls[0][1]).toBe(`giveback:${HOLDER}`);
  });

  it("limiter unavailable → 503, no RPC", async () => {
    consumeRateLimit.mockResolvedValue("unavailable");
    await expectError(await post(), 503, "SERVER");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("given_back", () => {
  it("calls give_back_seat with the host tenant and the session buyer, never the body", async () => {
    await post({ body: JSON.stringify({ holderId: LEADER }) });
    expect(rpc).toHaveBeenCalledWith("give_back_seat", {
      p_ticket_id: TICKET,
      p_tenant_id: TENANT,
      p_holder_id: HOLDER,
    });
  });

  it("200 { ok: true }, no-store", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("emails the leader's live profile address with seatGivenBackEmail", async () => {
    await post();
    expect(calls.buyer_profiles).toEqual(
      expect.arrayContaining([
        ["eq", "id", LEADER],
        ["is", "deleted_at", null],
      ]),
    );
    expect(calls.tickets).toEqual(expect.arrayContaining([["eq", "id", TICKET], ["eq", "tenant_id", TENANT]]));
    expect(calls.tenants).toEqual(expect.arrayContaining([["eq", "id", TENANT]]));
    const mail = seatGivenBackEmail({ tier: "VIP", tenantName: "Sky Festival", logoUrl: "https://cdn.example/logo.png" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith({ to: "leader@example.test", subject: mail.subject, html: mail.html });
  });

  it("a failed send still answers 200, with a fixed log line", async () => {
    sendEmail.mockResolvedValue(false);
    const res = await post();
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[me/tickets/give-back] email not sent");
  });

  it("a throwing send still answers 200", async () => {
    sendEmail.mockRejectedValue(new Error("network"));
    const res = await post();
    expect(res.status).toBe(200);
  });

  it("a deleted or missing leader profile → no email, still 200", async () => {
    reads.buyer_profiles = { data: null, error: null };
    const res = await post();
    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a read error for the email → no email, still 200", async () => {
    reads.tenants = { data: null, error: { code: "XX000" } };
    const res = await post();
    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("refusals", () => {
  it("refused → 404, no email", async () => {
    rpcResult = { data: [{ result: "refused", leader_id: null }], error: null };
    await expectError(await post(), 404, "NOT_FOUND");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("an RPC error → 503, no email", async () => {
    rpcResult = { data: null, error: { code: "XX000" } };
    await expectError(await post(), 503, "SERVER");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
