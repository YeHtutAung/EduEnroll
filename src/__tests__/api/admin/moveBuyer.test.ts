import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Result = { data: unknown; error: unknown };
type Call = { table: string; op: string; args: unknown[] };

// Each table answers its reads in order; an empty queue answers "no row".
let queues: Record<string, Result[]>;
let rpcResult: Result;
const calls: Call[] = [];
const rpc = vi.fn((...args: unknown[]) => {
  void args;
  return Promise.resolve(rpcResult);
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireAuth: vi.fn(), requireOwner: vi.fn() };
});

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmail: vi.fn() };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc,
    from: (table: string) => {
      const next = () => Promise.resolve(queues[table]?.shift() ?? { data: null, error: null });
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "is", "order"]) {
        chain[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return chain;
        };
      }
      chain.maybeSingle = () => next();
      chain.single = () => next();
      return chain;
    },
  }),
}));

import { requireAuth, requireOwner } from "@/lib/api";
import { sendEmail } from "@/lib/email";
import { POST } from "@/app/api/admin/enrollments/[id]/move-buyer/route";

const REFUSAL = { error: "Conflict", message: "This order can't be moved to that account." };
const TARGET = { id: "buyer-new", email: "new@gmail.com" };
const OLD = { id: "buyer-old", email: "old@gmail.com", deleted_at: null };

function send(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/admin/enrollments/11111111-1111-4111-8111-111111111111/move-buyer", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: { id: "11111111-1111-4111-8111-111111111111" } },
  );
}

function owner(isAgent = false) {
  vi.mocked(requireOwner).mockResolvedValue({
    tenantId: "tenant-A",
    user: { id: "owner-1", role: "owner" },
    isAgent,
  } as unknown as Awaited<ReturnType<typeof requireOwner>>);
}

function callsOn(table: string, op?: string) {
  return calls.filter((c) => c.table === table && (!op || c.op === op));
}

const good = { email: " New@Gmail.com ", reason: "  Lost the old mailbox; checked payment proof.  " };

beforeEach(() => {
  calls.length = 0;
  rpc.mockClear();
  vi.mocked(sendEmail).mockReset();
  vi.mocked(sendEmail).mockResolvedValue(true);
  vi.mocked(requireAuth).mockReset();
  vi.mocked(requireOwner).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  owner();
  queues = {
    buyer_profiles: [
      { data: TARGET, error: null },
      { data: OLD, error: null },
    ],
    enrollments: [{ data: { enrollment_ref: "SF2-1104-ABC123" }, error: null }],
    tenants: [{ data: { name: "Sky Festival", subdomain: "skyfestival", logo_url: null }, error: null }],
  };
  rpcResult = { data: [{ result: "moved", from_buyer_id: "buyer-old" }], error: null };
});

describe("POST /api/admin/enrollments/[id]/move-buyer", () => {
  it("is gated by requireOwner, not requireAuth", async () => {
    await send(good);

    expect(requireOwner).toHaveBeenCalled();
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it("passes requireOwner's refusal through", async () => {
    vi.mocked(requireOwner).mockResolvedValue(
      new (await import("next/server")).NextResponse(
        JSON.stringify({ error: "Forbidden", message: "Owner access required." }),
        { status: 403 },
      ),
    );
    const res = await send(good);

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(callsOn("buyer_profiles")).toHaveLength(0);
  });

  it("refuses the bot", async () => {
    owner(true);
    const res = await send(good);

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["{not json"],
    [{}],
    [{ email: 42, reason: "ok" }],
    [{ email: "not an email", reason: "ok" }],
    [{ email: "a@gmail.com,b@gmail.com", reason: "ok" }],
    [{ email: "a@gmail.com" }],
    [{ email: "a@gmail.com", reason: 7 }],
    [{ email: "a@gmail.com", reason: "   " }],
    [{ email: "a@gmail.com", reason: "x".repeat(501) }],
  ])("refuses %j with 400", async (body) => {
    const res = await send(body);

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts a 500-char reason", async () => {
    const res = await send({ email: "new@gmail.com", reason: ` ${"x".repeat(500)} ` });
    expect(res.status).toBe(200);
  });

  it("looks the target up by its normalized email among live profiles", async () => {
    await send(good);

    const lookup = callsOn("buyer_profiles");
    expect(lookup).toContainEqual({ table: "buyer_profiles", op: "eq", args: ["email", "new@gmail.com"] });
    expect(lookup).toContainEqual({ table: "buyer_profiles", op: "is", args: ["deleted_at", null] });
  });

  it("answers the one refusal, with no RPC, when no live account has that email", async () => {
    queues.buyer_profiles = [{ data: null, error: null }];
    const res = await send(good);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual(REFUSAL);
    expect(rpc).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("answers 500 when the target lookup fails", async () => {
    queues.buyer_profiles = [{ data: null, error: { code: "XX000" } }];
    const res = await send(good);

    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: [{ result: "refused", from_buyer_id: null }], error: null }],
    [{ data: [], error: null }],
    [{ data: null, error: null }],
    [{ data: [{ result: "MOVED", from_buyer_id: "x" }], error: null }],
  ])("answers the same refusal when the database refuses (%j)", async (result) => {
    rpcResult = result;
    const res = await send(good);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual(REFUSAL);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("answers 500 when the RPC errors", async () => {
    rpcResult = { data: null, error: { code: "XX000" } };
    const res = await send(good);

    expect(res.status).toBe(500);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("moves with the session's tenant and user and the looked-up buyer, never the body's", async () => {
    const res = await send({
      ...good,
      tenantId: "tenant-EVIL",
      tenant_id: "tenant-EVIL",
      buyerId: "buyer-EVIL",
      to_buyer_id: "buyer-EVIL",
      staffUserId: "staff-EVIL",
      enrollmentId: "order-EVIL",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("move_order_buyer", {
      p_enrollment_id: "11111111-1111-4111-8111-111111111111",
      p_tenant_id: "tenant-A",
      p_staff_user_id: "owner-1",
      p_to_buyer_id: "buyer-new",
      p_reason: "Lost the old mailbox; checked payment proof.",
    });
  });

  it("escapes the organiser name and the reference in both emails", async () => {
    queues.enrollments = [{ data: { enrollment_ref: "R<1>&\"" }, error: null }];
    queues.tenants = [{ data: { name: "A&B <script>\"x\"", subdomain: "skyfestival", logo_url: null }, error: null }];
    await send(good);

    for (const [m] of vi.mocked(sendEmail).mock.calls) {
      expect(m.html).not.toContain("<script>");
      expect(m.html).not.toContain("R<1>");
      expect(m.html).toContain("A&amp;B &lt;script&gt;");
    }
  });

  it("answers 404 for a malformed order id and reads nothing", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/admin/enrollments/not-a-uuid/move-buyer", {
        method: "POST",
        body: JSON.stringify(good),
      }),
      { params: { id: "not-a-uuid" } },
    );

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("emails the old address and the new one, with the reference and the organiser", async () => {
    await send(good);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    const byTo = new Map(vi.mocked(sendEmail).mock.calls.map(([m]) => [m.to, m]));
    const away = byTo.get("old@gmail.com");
    const into = byTo.get("new@gmail.com");
    expect(away?.subject).toMatch(/moved to another account/i);
    expect(away?.html).toContain("SF2-1104-ABC123");
    expect(away?.html).toContain("Sky Festival");
    expect(into?.subject).toMatch(/added to your account/i);
    expect(into?.html).toContain("SF2-1104-ABC123");
    expect(into?.html).toContain("Sky Festival");
    expect(into?.html).toContain("/account/tickets");
    // The link is on the tenant's own host, never the request's.
    expect(into?.html).toMatch(/https?:\/\/[^"'\s<]*skyfestival[^"'\s<]*\/account\/tickets/);

    // The old profile is read by the id the database returned; the order by tenant.
    expect(callsOn("buyer_profiles")).toContainEqual({ table: "buyer_profiles", op: "eq", args: ["id", "buyer-old"] });
    expect(callsOn("enrollments")).toContainEqual({ table: "enrollments", op: "eq", args: ["id", "11111111-1111-4111-8111-111111111111"] });
    expect(callsOn("enrollments")).toContainEqual({ table: "enrollments", op: "eq", args: ["tenant_id", "tenant-A"] });
  });

  it.each([
    ["missing", null],
    ["deleted", { ...OLD, deleted_at: "2026-11-01T00:00:00Z" }],
  ])("skips the old address when its profile is %s", async (_label, row) => {
    queues.buyer_profiles = [
      { data: TARGET, error: null },
      { data: row, error: null },
    ];
    const res = await send(good);

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail).mock.calls[0][0].to).toBe("new@gmail.com");
  });

  it("still answers 200, with a fixed log, when a send fails", async () => {
    vi.mocked(sendEmail).mockResolvedValue(false);
    const res = await send(good);

    expect(res.status).toBe(200);
    for (const [first, ...rest] of vi.mocked(console.error).mock.calls) {
      expect(typeof first).toBe("string");
      expect(String(first)).not.toContain("@");
      expect(rest.join(" ")).not.toContain("@");
    }
    expect(console.error).toHaveBeenCalled();
  });

  it("still answers 200 when a send throws", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("boom new@gmail.com"));
    const res = await send(good);

    expect(res.status).toBe(200);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("@");
  });

  it("still answers 200, sending nothing, when the email details can't be read", async () => {
    queues.enrollments = [{ data: null, error: { code: "XX000" } }];
    const res = await send(good);

    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
