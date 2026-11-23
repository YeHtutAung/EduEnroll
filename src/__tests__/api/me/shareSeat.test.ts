import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ─── POST/DELETE /api/me/tickets/[id]/share (plan 4 Task 8) ─────────────────
// Mocks requireBuyer, resolveTenantId, the admin client and the durable
// counter. The token is generated for real; its hash is checked against the
// one the RPC received.

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

// Records every token the route generates, so the logging test can look for it.
const generated: string[] = [];
vi.mock("@/server/tickets/shareLinks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tickets/shareLinks")>();
  return {
    ...actual,
    newShareToken: () => {
      const t = actual.newShareToken();
      generated.push(t);
      return t;
    },
  };
});

type Result = { data: unknown; error: unknown };
let tenantRead: Result;
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
  q.maybeSingle = vi.fn(async () => tenantRead);
  q.single = vi.fn(async () => tenantRead);
  return q;
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from, rpc }) }));

import { POST, DELETE, dynamic } from "@/app/api/me/tickets/[id]/share/route";
import { hashShareToken } from "@/server/tickets/shareLinks";
import { tenantLinkOrigin } from "@/lib/origin";

const TICKET = "11111111-2222-4333-8444-555555555555";
const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BUYER = "99999999-8888-4777-8666-555555555555";
const EXPIRES = "2026-12-18T17:30:00+00:00";

function call(method: "POST" | "DELETE", opts: { id?: string; body?: string; headers?: Record<string, string> } = {}) {
  const id = opts.id ?? TICKET;
  const req = new Request(`https://sky.kuunyi.com/api/me/tickets/${id}/share`, {
    method,
    body: opts.body,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
  });
  return (method === "POST" ? POST : DELETE)(req, { params: { id } });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const json = await res.json();
  expect(json).toMatchObject({ error: { code } });
  return json as { error: { code: string; message: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  generated.length = 0;
  for (const k of Object.keys(calls)) delete calls[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  requireBuyer.mockResolvedValue({ buyerId: BUYER, email: "leader@example.test", isReviewer: false, sessionId: "s1" });
  resolveTenantId.mockResolvedValue(TENANT);
  consumeRateLimit.mockResolvedValue("ok");
  tenantRead = { data: { subdomain: "sky" }, error: null };
  rpcResult = { data: [{ result: "created", expires_at: EXPIRES }], error: null };
});

describe("dynamic", () => {
  it("is force-dynamic", () => expect(dynamic).toBe("force-dynamic"));
});

describe.each(["POST", "DELETE"] as const)("%s guards", (method) => {
  it("cross-site → 403 and no Auth call", async () => {
    await expectError(await call(method, { headers: { "sec-fetch-site": "cross-site" } }), 403, "FORBIDDEN");
    expect(requireBuyer).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a sibling subdomain Origin → 403", async () => {
    const res = await call(method, { headers: { origin: "https://evil.kuunyi.com", host: "sky.kuunyi.com" } });
    await expectError(res, 403, "FORBIDDEN");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("signed out → 401, no RPC", async () => {
    requireBuyer.mockResolvedValue(
      NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in required." } }, { status: 401 }),
    );
    await expectError(await call(method), 401, "UNAUTHENTICATED");
    expect(rpc).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("malformed id → 404, no RPC", async () => {
    await expectError(await call(method, { id: "not-a-uuid" }), 404, "NOT_FOUND");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an unknown tenant → resolveTenantId's error, no RPC", async () => {
    resolveTenantId.mockResolvedValue(NextResponse.json({ error: "Not Found" }, { status: 404 }));
    const res = await call(method);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("limited → 429 and no RPC", async () => {
    consumeRateLimit.mockResolvedValue("limited");
    await expectError(await call(method), 429, "RATE_LIMITED");
    expect(rpc).not.toHaveBeenCalled();
    expect(consumeRateLimit.mock.calls[0][1]).toBe(`share:${BUYER}`);
  });

  it("limiter unavailable → 503 and no RPC", async () => {
    consumeRateLimit.mockResolvedValue("unavailable");
    await expectError(await call(method), 503, "SERVER");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("POST: create or replace the link", () => {
  it("calls create_share_link with the host tenant, the session buyer and a 64-hex hash", async () => {
    // A body naming another buyer, ticket or tenant is ignored.
    const res = await call("POST", {
      body: JSON.stringify({ p_leader_id: "x", leaderId: "x", tenantId: "x", ticketId: "x", token: "x" }),
    });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, string>];
    expect(name).toBe("create_share_link");
    expect(Object.keys(args).sort()).toEqual(["p_leader_id", "p_tenant_id", "p_ticket_id", "p_token_hash"]);
    expect(args).toMatchObject({ p_ticket_id: TICKET, p_tenant_id: TENANT, p_leader_id: BUYER });
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers 200 { url, expiresAt }, the url on the tenant's link origin, no-store", async () => {
    const res = await call("POST");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "url"]);
    expect(body.expiresAt).toBe(EXPIRES);
    const prefix = `${tenantLinkOrigin("sky")}/t/claim#`;
    expect(body.url.startsWith(prefix)).toBe(true);
    const token = body.url.slice(prefix.length);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const args = rpc.mock.calls[0][1] as Record<string, string>;
    expect(hashShareToken(token)).toBe(args.p_token_hash);
    // Never in a header.
    for (const [, v] of res.headers) expect(v).not.toContain(token);
  });

  it("reads the tenant's subdomain by the host tenant id", async () => {
    await call("POST");
    expect(calls.tenants).toEqual(expect.arrayContaining([["select", "subdomain"], ["eq", "id", TENANT]]));
  });

  it("a tenant read error → 503, no RPC", async () => {
    tenantRead = { data: null, error: { code: "XX000" } };
    await expectError(await call("POST"), 503, "SERVER");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refused → 404 'Seat not available to share.'", async () => {
    rpcResult = { data: [{ result: "refused", expires_at: null }], error: null };
    const json = await expectError(await call("POST"), 404, "NOT_FOUND");
    expect(json.error.message).toBe("Seat not available to share.");
  });

  it("an unexpected answer → the same 404", async () => {
    rpcResult = { data: [], error: null };
    await expectError(await call("POST"), 404, "NOT_FOUND");
  });

  it("an RPC error → 503", async () => {
    rpcResult = { data: null, error: { code: "40P01" } };
    await expectError(await call("POST"), 503, "SERVER");
  });

  it("every 404 has the same body (malformed id and refused)", async () => {
    const a = await (await call("POST", { id: "nope" })).json();
    rpcResult = { data: [{ result: "refused", expires_at: null }], error: null };
    const b = await (await call("POST")).json();
    expect(a).toEqual(b);
  });
});

describe("DELETE: cancel the open link", () => {
  it("calls cancel_share_link with the host tenant and the session buyer", async () => {
    rpcResult = { data: "cancelled", error: null };
    await call("DELETE", { body: JSON.stringify({ leaderId: "x" }) });
    expect(rpc).toHaveBeenCalledWith("cancel_share_link", {
      p_ticket_id: TICKET,
      p_tenant_id: TENANT,
      p_leader_id: BUYER,
    });
  });

  it("cancelled → 200 { cancelled: true }", async () => {
    rpcResult = { data: "cancelled", error: null };
    const res = await call("DELETE");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ cancelled: true });
  });

  it("none → 200 { cancelled: false }", async () => {
    rpcResult = { data: "none", error: null };
    const res = await call("DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: false });
  });

  it("refused → 404", async () => {
    rpcResult = { data: "refused", error: null };
    await expectError(await call("DELETE"), 404, "NOT_FOUND");
  });

  it("an RPC error → 503", async () => {
    rpcResult = { data: null, error: { code: "XX000" } };
    await expectError(await call("DELETE"), 503, "SERVER");
  });

  it("uses limitShare", async () => {
    rpcResult = { data: "none", error: null };
    await call("DELETE");
    expect(consumeRateLimit.mock.calls.map((c) => c[1])).toEqual([`share:${BUYER}`]);
  });
});

describe("logging", () => {
  it("no log line carries the token or its hash, on success or on any failure", async () => {
    const spies = [console.error, console.log, console.warn] as unknown as Array<{ mock: { calls: unknown[][] } }>;
    const scenarios: Array<() => void> = [
      () => {},
      () => (rpcResult = { data: null, error: { code: "XX000", message: "boom", details: "d" } }),
      () => (rpcResult = { data: [{ result: "refused", expires_at: null }], error: null }),
    ];
    const hashes: string[] = [];
    for (const setup of scenarios) {
      setup();
      await call("POST");
      hashes.push((rpc.mock.calls.at(-1)![1] as Record<string, string>).p_token_hash);
    }
    expect(generated.length).toBe(scenarios.length);
    const logged = spies.flatMap((s) => s.mock.calls).map((args) => JSON.stringify(args));
    expect(logged.length).toBeGreaterThan(0); // the failure paths do log
    for (const line of logged) {
      for (const secret of [...generated, ...hashes]) expect(line).not.toContain(secret);
    }
  });
});
