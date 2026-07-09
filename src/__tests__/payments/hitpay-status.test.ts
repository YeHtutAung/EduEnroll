import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-1"),
}));

const { GET } = await import("@/app/api/public/payments/hitpay/status/route");

function makeRequest(ref?: string) {
  const url = ref
    ? `http://localhost/api/public/payments/hitpay/status?ref=${encodeURIComponent(ref)}`
    : "http://localhost/api/public/payments/hitpay/status";
  return new NextRequest(url);
}

function setupEnrollmentMock(status: string | null) {
  mockAdminFrom.mockImplementation(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: status !== null ? { status } : null,
      error: null,
    }),
  }));
}

describe("GET /api/public/payments/hitpay/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when ref is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it("returns 404 when enrollment not found", async () => {
    setupEnrollmentMock(null);
    const res = await GET(makeRequest("NM-2026-0001"));
    expect(res.status).toBe(404);
  });

  it("returns enrollmentStatus=pending_payment while waiting", async () => {
    setupEnrollmentMock("pending_payment");
    const res = await GET(makeRequest("NM-2026-0001"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrollmentStatus).toBe("pending_payment");
  });

  it("returns enrollmentStatus=confirmed when payment approved", async () => {
    setupEnrollmentMock("confirmed");
    const res = await GET(makeRequest("NM-2026-0001"));
    const body = await res.json();
    expect(body.enrollmentStatus).toBe("confirmed");
  });

  it("returns enrollmentStatus=rejected when payment failed", async () => {
    setupEnrollmentMock("rejected");
    const res = await GET(makeRequest("NM-2026-0001"));
    const body = await res.json();
    expect(body.enrollmentStatus).toBe("rejected");
  });
});
