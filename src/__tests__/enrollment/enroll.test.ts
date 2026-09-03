import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { hashPriorityToken } from "@/lib/interest/token";

// ─── Mock dependencies ────────────────────────────────────────────────────────

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-abc"),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  enrollmentConfirmationEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
}));

// ─── Import AFTER mocks are set up ───────────────────────────────────────────

const { POST } = await import("@/app/api/public/enroll/route");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: object) {
  return new NextRequest("http://localhost/api/public/enroll", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/**
 * Returns a chainable Supabase mock that resolves with `result` when awaited.
 * Every method returns the same chain so `.select().eq().single()` etc. all work.
 */
function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "eq", "neq", "update", "order", "limit", "single", "maybeSingle", "insert", "delete", "upsert"];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Make awaiting the chain return `result`
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

/** Minimal tenant row returned by the tenants query. */
const TENANT_ROW = {
  data: { name: "Test School", org_type: "language_school", logo_url: null, email_on_enroll: false, currency: "MMK" },
  error: null,
};

/** Empty bank accounts list. */
const BANK_ACCOUNTS_ROW = { data: [], error: null };

/**
 * Sets up mockFrom to handle all table queries that happen after a successful RPC.
 * Tables queried (in the no-form_data path): tenants, bank_accounts.
 */
function setupFromSuccess() {
  mockFrom.mockImplementation((table: string) => {
    if (table === "tenants") return makeChain(TENANT_ROW);
    if (table === "bank_accounts") return makeChain(BANK_ACCOUNTS_ROW);
    // Fallback for any other table
    return makeChain({ data: null, error: null });
  });
}

function mockRpcSuccess() {
  mockRpc.mockResolvedValue({
    data: {
      success: true,
      enrollment_id: "enroll-1",
      enrollment_ref: "NM-2026-0001",
      class_level: "N5",
      fee_amount: 50000,
      quantity: 1,
      tenant_id: "tenant-abc",
    },
    error: null,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/public/enroll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFromSuccess();
  });

  it("returns 400 when class_id is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when class_id is not a valid UUID", async () => {
    const res = await POST(makeRequest({ class_id: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("returns fake 200 when honeypot field is filled", async () => {
    const res = await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001", __hp: "bot" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrollment_ref).toBe("OK-0000-0000");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 409 when class is full", async () => {
    mockRpc.mockResolvedValue({
      data: { success: false, error: "CLASS_FULL" },
      error: null,
    });
    const res = await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Class Full");
  });

  it("returns 409 when not enough seats for requested quantity", async () => {
    mockRpc.mockResolvedValue({
      data: { success: false, error: "NOT_ENOUGH_SEATS", seat_remaining: 2 },
      error: null,
    });
    const res = await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001", quantity: 5 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Not Enough Seats");
  });

  it("returns 201 with enrollment_ref on success", async () => {
    mockRpcSuccess();
    const res = await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.enrollment_ref).toBe("NM-2026-0001");
  });

  it("calls submit_enrollment RPC exactly once per request", async () => {
    mockRpcSuccess();
    await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001" }));
    const rpcCalls = mockRpc.mock.calls.filter((c) => c[0] === "submit_enrollment");
    expect(rpcCalls).toHaveLength(1);
  });

  it("routes to cart handler when items array is present", async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        enrollment_id: "enroll-2",
        enrollment_ref: "NM-2026-0002",
        quantity: 2,
        total_fee: 100000,
        tenant_id: "tenant-abc",
        items: [{ class_id: "00000000-0000-0000-0000-000000000001", class_level: "N5", quantity: 2, fee_amount: 50000 }],
      },
      error: null,
    });
    const res = await POST(makeRequest({
      items: [{ class_id: "00000000-0000-0000-0000-000000000001", quantity: 2 }],
      form_data: {},
    }));
    expect(res.status).toBe(201);
    const rpcCalls = mockRpc.mock.calls.filter((c) => c[0] === "submit_cart_enrollment");
    expect(rpcCalls).toHaveLength(1);
  });

  // ─── priority_token wiring ──────────────────────────────────────────────

  it("hashes a supplied priority_token and passes the hash — never the raw value — to submit_enrollment", async () => {
    mockRpcSuccess();
    const rawToken = "super-secret-raw-priority-token";
    const expectedHash = hashPriorityToken(rawToken);

    await POST(makeRequest({
      class_id: "00000000-0000-0000-0000-000000000001",
      priority_token: rawToken,
    }));

    const rpcCall = mockRpc.mock.calls.find((c) => c[0] === "submit_enrollment");
    expect(rpcCall).toBeDefined();
    const rpcArgs = rpcCall![1] as Record<string, unknown>;
    expect(rpcArgs.p_priority_token_hash).toBe(expectedHash);
    expect(JSON.stringify(rpcArgs)).not.toContain(rawToken);
  });

  it("passes null for submit_enrollment when priority_token is absent, empty, or non-string", async () => {
    mockRpcSuccess();

    await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001" }));
    let rpcCall = mockRpc.mock.calls.find((c) => c[0] === "submit_enrollment");
    expect((rpcCall![1] as Record<string, unknown>).p_priority_token_hash).toBeNull();

    mockRpc.mockClear();
    mockRpcSuccess();
    await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001", priority_token: "" }));
    rpcCall = mockRpc.mock.calls.find((c) => c[0] === "submit_enrollment");
    expect((rpcCall![1] as Record<string, unknown>).p_priority_token_hash).toBeNull();

    mockRpc.mockClear();
    mockRpcSuccess();
    await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001", priority_token: 12345 }));
    rpcCall = mockRpc.mock.calls.find((c) => c[0] === "submit_enrollment");
    expect((rpcCall![1] as Record<string, unknown>).p_priority_token_hash).toBeNull();
  });

  it("hashes a supplied priority_token and passes the hash — never the raw value — to submit_cart_enrollment", async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        enrollment_id: "enroll-2",
        enrollment_ref: "NM-2026-0002",
        quantity: 2,
        total_fee: 100000,
        tenant_id: "tenant-abc",
        items: [{ class_id: "00000000-0000-0000-0000-000000000001", class_level: "N5", quantity: 2, fee_amount: 50000 }],
      },
      error: null,
    });
    const rawToken = "super-secret-raw-priority-token";
    const expectedHash = hashPriorityToken(rawToken);

    await POST(makeRequest({
      items: [{ class_id: "00000000-0000-0000-0000-000000000001", quantity: 2 }],
      priority_token: rawToken,
    }));

    const rpcCall = mockRpc.mock.calls.find((c) => c[0] === "submit_cart_enrollment");
    expect(rpcCall).toBeDefined();
    const rpcArgs = rpcCall![1] as Record<string, unknown>;
    expect(rpcArgs.p_priority_token_hash).toBe(expectedHash);
    expect(JSON.stringify(rpcArgs)).not.toContain(rawToken);
  });

  it("never includes the raw priority_token in the JSON response body", async () => {
    mockRpcSuccess();
    const rawToken = "super-secret-raw-priority-token";
    const res = await POST(makeRequest({
      class_id: "00000000-0000-0000-0000-000000000001",
      priority_token: rawToken,
    }));
    const bodyText = JSON.stringify(await res.json());
    expect(bodyText).not.toContain(rawToken);
  });
});
