import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@/lib/api";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/types/database", () => ({
  DEFAULT_APPEARANCE: { template_id: "ls-classic", primary_color: "#2563eb", tagline: null },
}));

import { requireOwner } from "@/lib/api";
import { PUT } from "@/app/api/admin/appearance/route";

// Supabase stub that returns success for any upsert
const mockSingle = vi.fn().mockResolvedValue({ data: { template_id: "ls-classic" }, error: null });
const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
const mockUpsert = vi.fn().mockReturnValue({ select: mockSelect });
const mockFrom = vi.fn().mockReturnValue({ upsert: mockUpsert });
const mockSupabase = { from: mockFrom };

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/admin/appearance", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PUT /api/admin/appearance — template_id validation", () => {
  beforeEach(() => {
    vi.mocked(requireOwner).mockResolvedValue({
      supabase: mockSupabase as never,
      tenantId: "test-tenant-id",
      user: {} as never,
      isAgent: false,
      agentChatId: null,
    } satisfies AuthContext);
  });

  const VALID_TEMPLATE_IDS = [
    "ls-classic",
    "ls-modern",
    "ls-warm",
    "ev-luxury",
    "ev-festival",
    "ev-corporate",
    "ev-trusted-official",
  ] as const;

  it.each(VALID_TEMPLATE_IDS)('accepts template_id "%s"', async (id) => {
    const res = await PUT(makeRequest({ template_id: id }));
    expect(res.status).not.toBe(400);
  });

  it("rejects an unknown template_id with 400", async () => {
    const res = await PUT(makeRequest({ template_id: "ev-unknown-template" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/template/i);
  });

  it("allows saving without template_id (partial update)", async () => {
    const res = await PUT(makeRequest({ primary_color: "#ff0000" }));
    expect(res.status).not.toBe(400);
  });

  it("accepts a valid sponsor placement configuration", async () => {
    const res = await PUT(
      makeRequest({
        sponsor_config: {
          presenting: {
            name: "Acme",
            logo_url: "https://cdn.example.com/acme.svg",
            url: "https://acme.example",
          },
          partners: [{ name: "Partner One", logo_url: "/partner-one.png" }],
          supported_by: [],
        },
      }),
    );
    expect(res.status).not.toBe(400);
  });

  it("rejects unsafe sponsor links", async () => {
    const res = await PUT(
      makeRequest({
        sponsor_config: {
          presenting: { name: "Unsafe", url: "javascript:alert(1)" },
          partners: [],
          supported_by: [],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid url/i);
  });

  it("rejects sponsor lists over their placement limits", async () => {
    const res = await PUT(
      makeRequest({
        sponsor_config: {
          presenting: null,
          partners: Array.from({ length: 13 }, (_, index) => ({ name: `Partner ${index}` })),
          supported_by: [],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at most 12/i);
  });

  it("returns 500 when the database rejects the upsert (e.g. CHECK constraint violation)", async () => {
    // Simulate the DB rejecting the value (e.g. template_id not in CHECK constraint)
    const failSingle = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "check constraint violated" } });
    const failSelect = vi.fn().mockReturnValue({ single: failSingle });
    const failUpsert = vi.fn().mockReturnValue({ select: failSelect });
    vi.mocked(requireOwner).mockResolvedValueOnce({
      supabase: { from: vi.fn().mockReturnValue({ upsert: failUpsert }) } as never,
      tenantId: "test-tenant-id",
      user: {} as never,
      isAgent: false,
      agentChatId: null,
    } satisfies AuthContext);

    const res = await PUT(makeRequest({ template_id: "ls-classic" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/save/i);
  });
});
