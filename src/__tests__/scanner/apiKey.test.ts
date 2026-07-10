import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

const { hashApiKey, resolveScannerTenant } = await import("@/lib/scanner/apiKey");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(authHeader?: string) {
  return new NextRequest("http://localhost/api/scans", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function setupKeyLookupMock(
  row: { tenant_id: string; revoked_at: string | null; key_hash: string } | null,
) {
  mockAdminFrom.mockImplementation(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: row, error: null }),
    update: vi.fn().mockReturnThis(),
  }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("hashApiKey", () => {
  it("returns a stable 64-char hex SHA-256 digest", () => {
    const expected = createHash("sha256").update("abc").digest("hex");
    const actual = hashApiKey("abc");
    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveScannerTenant", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns tenant_id for a valid Bearer key matching a non-revoked row", async () => {
    const rawKey = "testkey";
    setupKeyLookupMock({
      tenant_id: "tenant-1",
      revoked_at: null,
      key_hash: hashApiKey(rawKey),
    });

    const result = await resolveScannerTenant(makeRequest(`Bearer ${rawKey}`));
    expect(result).toBe("tenant-1");
  });

  it("returns null when there is no Authorization header", async () => {
    const result = await resolveScannerTenant(makeRequest());
    expect(result).toBeNull();
  });

  it("returns null when the DB returns no matching row (not found / revoked)", async () => {
    setupKeyLookupMock(null);
    const result = await resolveScannerTenant(makeRequest("Bearer somekey"));
    expect(result).toBeNull();
  });
});
