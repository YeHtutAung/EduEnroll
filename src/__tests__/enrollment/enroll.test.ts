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
const { TERMS_VERSION } = await import("@/lib/legal/terms");
const { organiserRulesFingerprint } = await import("@/server/legal/organiserRules");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A valid acceptance of the current terms, for an event with no organiser rules. */
const TERMS_OK = {
  terms_accepted: true,
  terms_version: TERMS_VERSION,
  organiser_terms_sha256: null,
};

/**
 * Every order must carry an acceptance of the terms, so the helper adds a
 * valid one by default. Tests about acceptance itself pass `{ terms: false }`
 * and put exactly the fields they want in `body`.
 */
function makeRequest(body: object, { terms = true }: { terms?: boolean } = {}) {
  return new NextRequest("http://localhost/api/public/enroll", {
    method: "POST",
    body: JSON.stringify(terms ? { ...TERMS_OK, ...body } : body),
    headers: { "content-type": "application/json" },
  });
}

/**
 * Returns a chainable Supabase mock that resolves with `result` when awaited.
 * Every method returns the same chain so `.select().eq().single()` etc. all work.
 */
function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "eq", "neq", "in", "update", "order", "limit", "single", "maybeSingle", "insert", "delete", "upsert"];
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

const CLASS_ID = "00000000-0000-0000-0000-000000000001";

type TermsLookup = {
  classes?: { data: unknown; error: unknown };
  intakes?: { data: unknown; error: unknown };
};

/** Every payload written to `enrollments` via update(), in order. */
let enrollmentUpdates: Record<string, unknown>[] = [];

/**
 * Sets up mockFrom for every table the route touches: the organiser-rules
 * check before the RPC (classes, intakes), the evidence write after it
 * (enrollments), and the response (tenants, bank_accounts).
 */
function setupFromSuccess(lookup: TermsLookup = {}) {
  enrollmentUpdates = [];
  mockFrom.mockImplementation((table: string) => {
    if (table === "tenants") return makeChain(TENANT_ROW);
    if (table === "bank_accounts") return makeChain(BANK_ACCOUNTS_ROW);
    // The organiser-rules check: class -> event -> rules.
    if (table === "classes") {
      return makeChain(lookup.classes ?? { data: [{ id: CLASS_ID, intake_id: "intake-1" }], error: null });
    }
    if (table === "intakes") {
      return makeChain(lookup.intakes ?? { data: [{ id: "intake-1", organiser_terms: null }], error: null });
    }
    if (table === "enrollments") {
      const chain = makeChain({ data: null, error: null });
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        enrollmentUpdates.push(payload);
        return chain;
      });
      return chain;
    }
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

// ─── Terms of Sale acceptance ───────────────────────────────────────────────
//
// Checked before any seat is reserved: a refused order must not have called
// the reservation RPC at all.

describe("POST /api/public/enroll — terms acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFromSuccess();
  });

  it("refuses an order that does not accept the terms, before reserving anything", async () => {
    mockRpcSuccess();
    const res = await POST(makeRequest({ class_id: CLASS_ID }, { terms: false }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("TERMS_REQUIRED");
    expect(body.message_mm).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([["the string 'true'", "true"], ["1", 1], ["false", false]])(
    "treats terms_accepted = %s as not accepted",
    async (_label, value) => {
      const res = await POST(
        makeRequest({ ...TERMS_OK, terms_accepted: value, class_id: CLASS_ID }, { terms: false }),
      );
      expect(res.status).toBe(400);
      expect(mockRpc).not.toHaveBeenCalled();
    },
  );

  it("refuses the cart path without acceptance too", async () => {
    const res = await POST(
      makeRequest({ items: [{ class_id: CLASS_ID, quantity: 1 }] }, { terms: false }),
    );
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("refuses an acceptance of an older terms version with 409, asking for a reload", async () => {
    const res = await POST(
      makeRequest({ ...TERMS_OK, terms_version: "2000-01-01", class_id: CLASS_ID }, { terms: false }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TERMS_CHANGED");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("refuses when the organiser's rules differ from the ones the buyer saw", async () => {
    setupFromSuccess({
      intakes: { data: [{ id: "intake-1", organiser_terms: "No outside food." }], error: null },
    });
    const res = await POST(makeRequest({ class_id: CLASS_ID })); // sent null: saw no rules
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TERMS_CHANGED");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("accepts when the fingerprint matches the organiser's current rules", async () => {
    const rules = [{ id: "intake-1", organiser_terms: "No outside food." }];
    setupFromSuccess({ intakes: { data: rules, error: null } });
    mockRpcSuccess();

    const res = await POST(
      makeRequest({ class_id: CLASS_ID, organiser_terms_sha256: organiserRulesFingerprint(rules) }),
    );
    expect(res.status).toBe(201);
  });

  it("fails closed with 503 when the organiser rules cannot be read", async () => {
    setupFromSuccess({ intakes: { data: null, error: { code: "57014" } } });
    const res = await POST(makeRequest({ class_id: CLASS_ID }));
    expect(res.status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("records what was accepted, and when, on the created order", async () => {
    const rules = [{ id: "intake-1", organiser_terms: "Bags are searched." }];
    setupFromSuccess({ intakes: { data: rules, error: null } });
    mockRpcSuccess();
    const before = Date.now();

    await POST(makeRequest({ class_id: CLASS_ID, organiser_terms_sha256: organiserRulesFingerprint(rules) }));

    const evidence = enrollmentUpdates.find((u) => "terms_accepted_at" in u);
    expect(evidence).toMatchObject({
      terms_version: TERMS_VERSION,
      organiser_terms_sha256: organiserRulesFingerprint(rules),
    });
    expect(Date.parse(evidence!.terms_accepted_at as string)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("still answers a filled honeypot with the fake success, with or without terms", async () => {
    const res = await POST(makeRequest({ class_id: CLASS_ID, __hp: "bot" }, { terms: false }));
    expect(res.status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
