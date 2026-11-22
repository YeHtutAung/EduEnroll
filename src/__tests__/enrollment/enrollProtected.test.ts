import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ─── POST /api/public/enroll on an account-bound event (Plan 3, Task 12) ────
// Design 5.2–5.3: a protected class needs a signed-in buyer; the buyer id comes
// from the verified session, never the body; the order email is the account
// email whatever the form said. An unprotected class is guest checkout as
// before: no requireBuyer call and no p_buyer_id.

const mockRpc = vi.fn();
const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-abc"),
}));

const mockRequireBuyer = vi.fn();
vi.mock("@/lib/buyers/requireBuyer", () => ({
  requireBuyer: () => mockRequireBuyer(),
}));

const mockProtected = vi.fn();
vi.mock("@/server/enrollment/protection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/enrollment/protection")>()),
  protectedClassIds: (...args: unknown[]) => mockProtected(...args),
}));

vi.mock("@/server/legal/organiserRules", () => ({
  checkTermsAcceptance: vi.fn().mockResolvedValue({ ok: true, evidence: {} }),
}));

vi.mock("@/server/conversions/captureAdContext", () => ({
  captureAdContext: vi.fn().mockResolvedValue(undefined),
}));

const mockConfirmation = vi.fn();
vi.mock("@/server/enrollment/enrollmentEmails", () => ({
  sendEnrollmentConfirmationEmail: (...args: unknown[]) => mockConfirmation(...args),
}));

const { POST } = await import("@/app/api/public/enroll/route");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CLASS_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_CLASS = "00000000-0000-0000-0000-000000000002";
const BUYER = { buyerId: "buyer-uuid-1", email: "leader@example.com", isReviewer: false, sessionId: "s1" };

function makeRequest(body: object) {
  return new NextRequest("http://localhost/api/public/enroll", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "update", "order", "limit", "single", "maybeSingle", "insert"]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

let enrollmentUpdates: Record<string, unknown>[] = [];

function setupTables() {
  enrollmentUpdates = [];
  mockFrom.mockImplementation((table: string) => {
    if (table === "tenants") {
      return makeChain({
        data: { name: "Sky", org_type: "event", logo_url: null, email_on_enroll: true, currency: "MMK", subdomain: "sky" },
        error: null,
      });
    }
    if (table === "bank_accounts") return makeChain({ data: [], error: null });
    if (table === "classes") {
      // A list for the runner check; .single() for createEnrollment's intake lookup.
      const chain = makeChain({
        data: [CLASS_ID, OTHER_CLASS].map((id) => ({ id, intake_id: "intake-1", pack_size: 1 })),
        error: null,
      });
      chain.single = vi.fn(() => makeChain({ data: { intake_id: "intake-1" }, error: null }));
      return chain;
    }
    if (table === "intake_form_fields") return makeChain({ data: [], error: null });
    if (table === "enrollments") {
      const chain = makeChain({ data: null, error: null });
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        enrollmentUpdates.push(payload);
        return chain;
      });
      return chain;
    }
    return makeChain({ data: null, error: null });
  });
}

const SINGLE_OK = {
  data: {
    success: true, enrollment_id: "enroll-1", enrollment_ref: "SF-1", class_level: "GA",
    fee_amount: 50000, quantity: 1, tenant_id: "tenant-abc",
  },
  error: null,
};
const CART_OK = {
  data: {
    success: true, enrollment_id: "enroll-1", enrollment_ref: "SF-1", tenant_id: "tenant-abc",
    total_fee: 50000, quantity: 1,
    items: [{ class_id: CLASS_ID, class_level: "GA", quantity: 1, fee_amount: 50000, subtotal: 50000 }],
  },
  error: null,
};

const buyerRefusal = (status: number) =>
  NextResponse.json({ error: { code: "X", message: "x" } }, { status });

beforeEach(() => {
  vi.clearAllMocks();
  setupTables();
  mockProtected.mockResolvedValue(new Set<string>());
  mockRequireBuyer.mockResolvedValue(BUYER);
});

const SIGN_IN = { error: "Unauthorized", message: "Sign in to buy tickets for this event." };
const STAFF = { error: "Forbidden", message: "Staff accounts can't buy account-bound tickets. Use another email." };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/public/enroll — unprotected (guest checkout unchanged)", () => {
  it("never asks for a buyer and sends no p_buyer_id (single)", async () => {
    mockRpc.mockResolvedValue(SINGLE_OK);
    const res = await POST(makeRequest({ class_id: CLASS_ID, form_data: { email: "guest@example.com" } }));
    expect(res.status).toBe(201);
    expect(mockRequireBuyer).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls[0][1]).not.toHaveProperty("p_buyer_id");
    expect(enrollmentUpdates.find((u) => "email" in u)?.email).toBe("guest@example.com");
    expect(mockConfirmation.mock.calls[0][0].fd.email).toBe("guest@example.com");
  });

  it("never asks for a buyer and sends no p_buyer_id (cart)", async () => {
    mockRpc.mockResolvedValue(CART_OK);
    const res = await POST(makeRequest({ items: [{ class_id: CLASS_ID, quantity: 1 }], form_data: { email: "g@example.com" } }));
    expect(res.status).toBe(201);
    expect(mockRequireBuyer).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls[0][1]).not.toHaveProperty("p_buyer_id");
  });

  it("asks about every valid class id in the order, and only those", async () => {
    mockRpc.mockResolvedValue(CART_OK);
    await POST(makeRequest({ items: [{ class_id: CLASS_ID, quantity: 1 }, { class_id: OTHER_CLASS, quantity: 1 }] }));
    expect(mockProtected).toHaveBeenCalledWith(expect.anything(), [CLASS_ID, OTHER_CLASS]);

    mockProtected.mockClear();
    await POST(makeRequest({ class_id: "not-a-uuid" }));
    expect(mockProtected).toHaveBeenCalledWith(expect.anything(), []);
  });

  it("a malformed class id still gets the existing 400, not a 503", async () => {
    const res = await POST(makeRequest({ class_id: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/public/enroll — protection can't be read", () => {
  it("answers 503 and reserves nothing; never treated as unprotected", async () => {
    mockProtected.mockResolvedValue(null);
    const res = await POST(makeRequest({ class_id: CLASS_ID, form_data: { email: "g@example.com" } }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Service Unavailable");
    expect(typeof body.message).toBe("string");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRequireBuyer).not.toHaveBeenCalled();
  });
});

describe("POST /api/public/enroll — protected class", () => {
  beforeEach(() => {
    mockProtected.mockResolvedValue(new Set([CLASS_ID]));
  });

  it.each([
    ["single", { class_id: CLASS_ID, form_data: { email: "x@example.com" } }],
    ["cart", { items: [{ class_id: OTHER_CLASS, quantity: 1 }, { class_id: CLASS_ID, quantity: 1 }] }],
  ])("no buyer session (%s) → 401, no RPC", async (_n, body) => {
    mockRequireBuyer.mockResolvedValue(buyerRefusal(401));
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(SIGN_IN);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("a staff session → 403 with the staff message, no RPC", async () => {
    mockRequireBuyer.mockResolvedValue(buyerRefusal(403));
    const res = await POST(makeRequest({ class_id: CLASS_ID, form_data: {} }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(STAFF);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("sign-in service unavailable → 503 in the route's shape, no RPC", async () => {
    mockRequireBuyer.mockResolvedValue(buyerRefusal(503));
    const res = await POST(makeRequest({ class_id: CLASS_ID, form_data: {} }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Service Unavailable");
    expect(typeof body.message).toBe("string");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("passes p_buyer_id from the session, never from the body", async () => {
    mockRpc.mockResolvedValue(SINGLE_OK);
    const res = await POST(makeRequest({
      class_id: CLASS_ID,
      form_data: { email: "leader@example.com" },
      buyer_id: "forged-buyer", p_buyer_id: "forged-buyer", tenant_id: "forged-tenant",
    }));
    expect(res.status).toBe(201);
    expect(mockRequireBuyer).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_buyer_id: BUYER.buyerId });
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain("forged");
  });

  it("the order email and the confirmation email are the account email, whatever the form said", async () => {
    mockRpc.mockResolvedValue(SINGLE_OK);
    const res = await POST(makeRequest({
      class_id: CLASS_ID,
      form_data: { name_en: "Leader", email: "someone-else@example.com", email_address: "b@example.com", custom_email_9: "c@example.com" },
    }));
    expect(res.status).toBe(201);
    const update = enrollmentUpdates.find((u) => "form_data" in u)!;
    expect(update.email).toBe(BUYER.email);
    expect(update.form_data).toEqual({
      name_en: "Leader", email: BUYER.email, email_address: BUYER.email, custom_email_9: BUYER.email,
    });
    const fd = mockConfirmation.mock.calls[0][0].fd;
    expect(fd.email).toBe(BUYER.email);
    expect(JSON.stringify(mockConfirmation.mock.calls)).not.toContain("someone-else");
  });

  it("a form with no email at all still gets the account email", async () => {
    mockRpc.mockResolvedValue(CART_OK);
    const res = await POST(makeRequest({ items: [{ class_id: CLASS_ID, quantity: 1 }], form_data: { name_en: "L" } }));
    expect(res.status).toBe(201);
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_buyer_id: BUYER.buyerId });
    expect(enrollmentUpdates.find((u) => "form_data" in u)?.email).toBe(BUYER.email);
    expect(mockConfirmation.mock.calls[0][0].fd.email).toBe(BUYER.email);
  });

  it("a protected draft (no form_data) passes p_buyer_id and leaves the email to the RPC", async () => {
    mockRpc.mockResolvedValue(CART_OK);
    const res = await POST(makeRequest({ items: [{ class_id: CLASS_ID, quantity: 1 }] }));
    expect(res.status).toBe(201);
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_buyer_id: BUYER.buyerId });
    // The RPC stored the buyer's profile email (Part A migration); the route
    // writes no email of its own for a draft.
    expect(enrollmentUpdates.some((u) => "email" in u)).toBe(false);
  });

  it.each([
    ["single", { class_id: CLASS_ID, form_data: {} }],
    ["cart", { items: [{ class_id: CLASS_ID, quantity: 1 }], form_data: {} }],
  ])("RPC BUYER_REQUIRED (%s) → 401 with the sign-in message", async (_n, body) => {
    mockRpc.mockResolvedValue({ data: { success: false, error: "BUYER_REQUIRED" }, error: null });
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(SIGN_IN);
  });

  it.each([
    ["single", { class_id: CLASS_ID, form_data: {} }],
    ["cart", { items: [{ class_id: CLASS_ID, quantity: 1 }], form_data: {} }],
  ])("RPC IDEMPOTENCY_CONFLICT (%s) → 409", async (_n, body) => {
    mockRpc.mockResolvedValue({ data: { success: false, error: "IDEMPOTENCY_CONFLICT" }, error: null });
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Conflict");
  });
});
