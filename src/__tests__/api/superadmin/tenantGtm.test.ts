import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/superadminAuth", () => ({ requireSuperadmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { PUT } from "@/app/api/superadmin/schools/[id]/gtm/route";

const TENANT = "tenant-1";
const SUPER = "super-1";

function put(body: unknown, raw = false) {
  return PUT(
    new Request(`http://localhost/api/superadmin/schools/${TENANT}/gtm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    }) as never,
    { params: { id: TENANT } },
  );
}

/** Admin client mock: the tenant read returns `existing`; the update is recorded. */
function mockAdmin(existing: { id: string; gtm_container_id: string | null } | null) {
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ eq: updateEq });
  const maybeSingle = vi.fn().mockResolvedValue({ data: existing, error: null });
  const select = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) });
  const from = vi.fn().mockReturnValue({ select, update });
  vi.mocked(createAdminClient).mockReturnValue({ from } as never);
  return { from, update, updateEq };
}

describe("PUT /api/superadmin/schools/[id]/gtm", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(requireSuperadmin).mockResolvedValue({ profile: { id: SUPER } } as never);
  });
  afterEach(() => log.mockRestore());

  it("401s when unauthenticated, and touches no data", async () => {
    vi.mocked(requireSuperadmin).mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    } as never);
    const res = await put({ gtm_container_id: "GTM-ABCD123" });
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("403s for a non-superadmin, and touches no data", async () => {
    vi.mocked(requireSuperadmin).mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    } as never);
    const res = await put({ gtm_container_id: "GTM-ABCD123" });
    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each(["GTM-<script>", "UA-123", "GTM-12", "GTM-ABCD EFG", "GTM-"])(
    "400s on malformed id %s",
    async (id) => {
      const m = mockAdmin({ id: TENANT, gtm_container_id: null });
      const res = await put({ gtm_container_id: id });
      expect(res.status).toBe(400);
      expect(m.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["not json", true],
    [[], false],
    [{}, false],
    [{ gtm_container_id: 5 }, false],
    [{ gtm_container_id: ["GTM-ABCD123"] }, false],
    [{ gtm_container_id: "GTM-ABCD123", plan: "suspended" }, false],
    [{ other: "GTM-ABCD123" }, false],
  ] as [unknown, boolean][])("400s on bad body %j", async (body, raw) => {
    const m = mockAdmin({ id: TENANT, gtm_container_id: null });
    const res = await put(body, raw);
    expect(res.status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("sets the id, normalising whitespace and case, via the admin client", async () => {
    const m = mockAdmin({ id: TENANT, gtm_container_id: null });
    const res = await put({ gtm_container_id: "  gtm-abcd123 " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gtm_container_id: "GTM-ABCD123" });
    expect(m.update).toHaveBeenCalledWith({ gtm_container_id: "GTM-ABCD123" });
    expect(m.updateEq).toHaveBeenCalledWith("id", TENANT);
  });

  it.each([null, "", "   "])("clears the id for %j", async (value) => {
    const m = mockAdmin({ id: TENANT, gtm_container_id: "GTM-ABCD123" });
    const res = await put({ gtm_container_id: value });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gtm_container_id: null });
    expect(m.update).toHaveBeenCalledWith({ gtm_container_id: null });
  });

  it("404s for an unknown tenant and updates nothing", async () => {
    const m = mockAdmin(null);
    const res = await put({ gtm_container_id: "GTM-ABCD123" });
    expect(res.status).toBe(404);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("logs exactly one line: tenant, superadmin, old -> new", async () => {
    mockAdmin({ id: TENANT, gtm_container_id: "GTM-OLD1234" });
    await put({ gtm_container_id: "GTM-NEW5678" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      `[gtm] tenant=${TENANT} changed by superadmin=${SUPER}: GTM-OLD1234 -> GTM-NEW5678`,
    );
  });

  it("logs null for an unset new value", async () => {
    mockAdmin({ id: TENANT, gtm_container_id: "GTM-OLD1234" });
    await put({ gtm_container_id: null });
    expect(log).toHaveBeenCalledWith(
      `[gtm] tenant=${TENANT} changed by superadmin=${SUPER}: GTM-OLD1234 -> null`,
    );
  });
});
