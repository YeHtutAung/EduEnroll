import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ─── POST /api/me/tickets/claim and /claim/preview (plan 4 Task 9) ──────────

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

import { POST as CLAIM, dynamic as claimDynamic } from "@/app/api/me/tickets/claim/route";
import { POST as PREVIEW, dynamic as previewDynamic } from "@/app/api/me/tickets/claim/preview/route";
import { hashShareToken, newShareToken } from "@/server/tickets/shareLinks";
import { seatClaimedEmail } from "@/lib/email";

const TICKET = "11111111-2222-4333-8444-555555555555";
const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FRIEND = "99999999-8888-4777-8666-555555555555";
const LEADER = "77777777-8888-4777-8666-555555555555";
const GONE = { error: { code: "NOT_FOUND", message: "This link no longer works." } };

let TOKEN: string;

function req(path: string, opts: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
  return new Request(`https://sky.kuunyi.com/api/me/tickets/${path}`, {
    method: "POST",
    body: opts.rawBody ?? JSON.stringify(opts.body ?? { token: TOKEN }),
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...(opts.headers ?? {}) },
  });
}
const claim = (opts?: Parameters<typeof req>[1]) => CLAIM(req("claim", opts));
const preview = (opts?: Parameters<typeof req>[1]) => PREVIEW(req("claim/preview", opts));

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toMatchObject({ error: { code } });
}

const buyerKeys = () => consumeRateLimit.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(calls)) delete calls[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  TOKEN = newShareToken();
  requireBuyer.mockResolvedValue({ buyerId: FRIEND, email: "friend@example.test", isReviewer: false, sessionId: "s1" });
  resolveTenantId.mockResolvedValue(TENANT);
  consumeRateLimit.mockResolvedValue("ok");
  sendEmail.mockResolvedValue(true);
  reads = {
    buyer_profiles: { data: { email: "leader@example.test" }, error: null },
    tickets: { data: { tier: "VIP" }, error: null },
    tenants: { data: { name: "Sky Festival", logo_url: null }, error: null },
  };
});

describe.each([
  ["claim", claim, () => (rpcResult = { data: [{ result: "claimed", ticket_id: TICKET, leader_id: LEADER }], error: null })],
  [
    "preview",
    preview,
    () =>
      (rpcResult = {
        data: [{ event_name: "Sky Festival", tier: "VIP", seat_no: 2, event_date: "2026-12-20" }],
        error: null,
      }),
  ],
] as const)("%s: shared refusals", (_name, send, succeed) => {
  beforeEach(() => succeed());

  it("is force-dynamic", () => {
    expect(claimDynamic).toBe("force-dynamic");
    expect(previewDynamic).toBe("force-dynamic");
  });

  it("cross-site → 403 and no Auth call", async () => {
    await expectError(await send({ headers: { "sec-fetch-site": "cross-site" } }), 403, "FORBIDDEN");
    expect(requireBuyer).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("signed out → 401, no RPC", async () => {
    requireBuyer.mockResolvedValue(
      NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in required." } }, { status: 401 }),
    );
    await expectError(await send(), 401, "UNAUTHENTICATED");
    expect(rpc).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("a body over 1024 bytes → 413, no RPC", async () => {
    await expectError(await send({ rawBody: JSON.stringify({ token: TOKEN, pad: "x".repeat(1100) }) }), 413, "VALIDATION");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a declared content-length over 1024 → 413", async () => {
    await expectError(await send({ headers: { "content-length": "5000" } }), 413, "VALIDATION");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["malformed", { token: "abc" }],
    ["non-string", { token: 12345 }],
    ["too long", { token: "A".repeat(44) }],
  ])("a %s token → the one 404, no limiter, no RPC", async (_k, body) => {
    const res = await send({ body });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(GONE);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("not JSON → the one 404", async () => {
    const res = await send({ rawBody: "token=abc" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(GONE);
  });

  it("limited → 429 before the RPC", async () => {
    consumeRateLimit.mockResolvedValue("limited");
    await expectError(await send(), 429, "RATE_LIMITED");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("limiter unavailable → 503 before the RPC", async () => {
    consumeRateLimit.mockResolvedValue("unavailable");
    await expectError(await send(), 503, "SERVER");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the per-IP key is a hash, never the raw IP", async () => {
    await send();
    const keys = buyerKeys();
    expect(keys.some((k) => k.startsWith("claimip:"))).toBe(true);
    for (const k of keys) expect(k).not.toContain("203.0.113.9");
  });

  it("an RPC error → 503", async () => {
    rpcResult = { data: null, error: { code: "XX000" } };
    await expectError(await send(), 503, "SERVER");
  });

  it("no log line carries the token or its hash", async () => {
    await send();
    rpcResult = { data: null, error: { code: "XX000", message: "boom" } };
    await send();
    consumeRateLimit.mockResolvedValue("unavailable");
    await send();
    const lines = [console.error, console.log, console.warn]
      .flatMap((s) => (s as unknown as { mock: { calls: unknown[][] } }).mock.calls)
      .map((a) => JSON.stringify(a));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(hashShareToken(TOKEN));
    }
  });
});

describe("claim", () => {
  beforeEach(() => {
    rpcResult = { data: [{ result: "claimed", ticket_id: TICKET, leader_id: LEADER }], error: null };
  });

  it("calls claim_share_link with the hash, the host tenant and the session buyer", async () => {
    await claim({ body: { token: TOKEN, claimerId: LEADER, tenantId: "x" } });
    expect(rpc).toHaveBeenCalledWith("claim_share_link", {
      p_token_hash: hashShareToken(TOKEN),
      p_tenant_id: TENANT,
      p_claimer_id: FRIEND,
    });
  });

  it("uses limitClaim, not limitPreview", async () => {
    await claim();
    expect(buyerKeys()[0]).toBe(`claim:${FRIEND}`);
    expect(buyerKeys().some((k) => k.startsWith("claimpreview:"))).toBe(false);
  });

  it("claimed → 200 { ticketId }, no-store", async () => {
    const res = await claim();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ticketId: TICKET });
  });

  it("emails the leader seatClaimedEmail with the claimer's masked address", async () => {
    await claim();
    expect(calls.buyer_profiles).toEqual(
      expect.arrayContaining([
        ["eq", "id", LEADER],
        ["is", "deleted_at", null],
      ]),
    );
    expect(calls.tickets).toEqual(expect.arrayContaining([["eq", "id", TICKET]]));
    const mail = seatClaimedEmail({ tier: "VIP", claimedBy: "f***@example.test", tenantName: "Sky Festival" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith({ to: "leader@example.test", subject: mail.subject, html: mail.html });
    expect(JSON.stringify(sendEmail.mock.calls)).not.toContain("friend@example.test");
  });

  it("no live leader profile → no email, still 200", async () => {
    reads.buyer_profiles = { data: null, error: null };
    const res = await claim();
    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a failed send still answers 200, with a fixed log line", async () => {
    sendEmail.mockResolvedValue(false);
    const res = await claim();
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[me/tickets/claim] email not sent");
  });

  it("a throwing send still answers 200", async () => {
    sendEmail.mockRejectedValue(new Error("network"));
    expect((await claim()).status).toBe(200);
  });

  it("refused → the same 404 body as a malformed token, no email", async () => {
    rpcResult = { data: [{ result: "refused", ticket_id: null, leader_id: null }], error: null };
    const res = await claim();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(GONE);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("an unexpected answer → the same 404", async () => {
    rpcResult = { data: [], error: null };
    const res = await claim();
    expect(await res.json()).toEqual(GONE);
  });
});

describe("preview", () => {
  beforeEach(() => {
    rpcResult = {
      data: [{ event_name: "Sky Festival", tier: "VIP", seat_no: 2, event_date: "2026-12-20" }],
      error: null,
    };
  });

  it("calls preview_share_link with the hash, the host tenant and the session buyer", async () => {
    await preview();
    expect(rpc).toHaveBeenCalledWith("preview_share_link", {
      p_token_hash: hashShareToken(TOKEN),
      p_tenant_id: TENANT,
      p_claimer_id: FRIEND,
    });
  });

  it("a row → 200 { eventName, tier, seatNo, eventDate }", async () => {
    const res = await preview();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ eventName: "Sky Festival", tier: "VIP", seatNo: 2, eventDate: "2026-12-20" });
  });

  it("no row → the one 404", async () => {
    rpcResult = { data: [], error: null };
    const res = await preview();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(GONE);
  });

  it("uses limitPreview, not limitClaim", async () => {
    await preview();
    expect(buyerKeys()[0]).toBe(`claimpreview:${FRIEND}`);
    expect(buyerKeys().some((k) => k.startsWith("claim:"))).toBe(false);
  });

  it("sends no email and changes nothing", async () => {
    await preview();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["preview_share_link"]);
  });
});
