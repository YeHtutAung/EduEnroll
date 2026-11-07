import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ─── Failed-lookup budget on the reference-only public routes ───────────────
//
// /api/public/status and /api/public/telegram-link-token both answer for an
// order on its reference alone. They share the per-address budget that
// /api/public/enrollment/[ref] already spends: misses count, hits do not, and
// a spent address is refused outright. Both look the order up on the tenant the
// request arrived on only, so another tenant's reference reads as not found.

type Row = Record<string, unknown>;

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn() }));

let tables: Record<string, Row[]>;
let readFails: string | null;
let updates: { table: string; values: unknown; filters: [string, unknown][] }[];

function chainFor(table: string) {
  const filters: [string, unknown][] = [];
  let pendingUpdate: unknown = undefined;

  const read = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
    if (table === readFails) return { data: null, error: { code: "08006", message: "connection lost" } };
    return { data: (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)), error: null };
  };

  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (key: string, value: unknown) => {
      filters.push([key, value]);
      return chain;
    },
    update: (values: unknown) => {
      pendingUpdate = values;
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    single: async () => {
      const { data, error } = read();
      if (error) return { data: null, error };
      if (data!.length === 0) return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { data: data![0], error: null };
    },
    maybeSingle: async () => {
      const { data, error } = read();
      return { data: data?.[0] ?? null, error };
    },
    then: (resolve: (v: unknown) => unknown) => {
      if (pendingUpdate !== undefined) {
        updates.push({ table, values: pendingUpdate, filters: [...filters] });
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      return Promise.resolve(read()).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: chainFor }),
}));

import { resolveTenantId } from "@/lib/api";
import { publicEnrollmentLookupLimiter } from "@/lib/rateLimit";
import { GET as statusGET } from "@/app/api/public/status/route";
import { POST as linkPOST } from "@/app/api/public/telegram-link-token/route";

const LIMIT = 10;
const OWN_REF = "OWN-REF";
const OTHER_TENANT_REF = "OTHER-REF";

function statusRequest(ref: string, ip = "198.51.100.7") {
  return new NextRequest(`https://t.kuunyi.com/api/public/status?ref=${encodeURIComponent(ref)}`, {
    headers: { "x-real-ip": ip },
  });
}

function linkRequest(ref: string, ip = "198.51.100.7") {
  return new NextRequest("https://t.kuunyi.com/api/public/telegram-link-token", {
    method: "POST",
    headers: { "x-real-ip": ip, "Content-Type": "application/json" },
    body: JSON.stringify({ enrollment_ref: ref }),
  });
}

async function spendBudget(ip = "198.51.100.7") {
  for (let i = 0; i < LIMIT; i++) {
    const res = await statusGET(statusRequest(`MISSING-${i}`, ip));
    expect(res.status).toBe(404);
  }
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  publicEnrollmentLookupLimiter.reset();
  vi.mocked(resolveTenantId).mockResolvedValue("ten-1");
  readFails = null;
  updates = [];
  tables = {
    enrollments: [
      {
        id: "enr-own",
        tenant_id: "ten-1",
        enrollment_ref: OWN_REF,
        status: "payment_submitted",
        class_id: "cls-1",
        quantity: 1,
        student_name_en: "Own Buyer",
        telegram_chat_id: null,
        classes: { id: "cls-1", level: "N5", fee_amount: 1000, image_url: null, pack_size: 1, intakes: null },
      },
      {
        id: "enr-other",
        tenant_id: "ten-2",
        enrollment_ref: OTHER_TENANT_REF,
        status: "payment_submitted",
        class_id: "cls-2",
        quantity: 1,
        student_name_en: "Other Buyer",
        telegram_chat_id: null,
        classes: { id: "cls-2", level: "GA", fee_amount: 2000, image_url: null, pack_size: 1, intakes: null },
      },
    ],
    tenants: [
      { id: "ten-1", org_type: "language_school", currency: "MMK" },
      { id: "ten-2", org_type: "event", currency: "MMK" },
    ],
    tenant_bots: [
      { tenant_id: "ten-1", bot_type: "enrollment", bot_username: "own_bot", enabled: true },
      { tenant_id: "ten-2", bot_type: "enrollment", bot_username: "other_bot", enabled: true },
    ],
  };
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("GET /api/public/status", () => {
  it("answers a valid reference with no-store", async () => {
    const res = await statusGET(statusRequest(OWN_REF));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).student_name_en).toBe("Own Buyer");
  });

  it("answers an unknown reference 404 with no-store", async () => {
    const res = await statusGET(statusRequest("MISSING"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers another tenant's reference exactly as an unknown one", async () => {
    const other = await statusGET(statusRequest(OTHER_TENANT_REF));
    const missing = await statusGET(statusRequest("MISSING"));
    expect(other.status).toBe(404);
    const otherBody = await other.json();
    expect(otherBody).toEqual(await missing.json());
    expect(JSON.stringify(otherBody)).not.toContain("Other Buyer");
    // The wording follows the tenant the request arrived on, not the order's.
    expect(otherBody.org_type).toBe("language_school");
  });

  it("refuses an address once its misses are spent, with Retry-After", async () => {
    await spendBudget();
    const res = await statusGET(statusRequest("MISSING-again"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("counts another tenant's reference as a miss", async () => {
    for (let i = 0; i < LIMIT; i++) {
      expect((await statusGET(statusRequest(OTHER_TENANT_REF))).status).toBe(404);
    }
    expect((await statusGET(statusRequest(OWN_REF))).status).toBe(429);
  });

  it("refuses a valid reference too once the address is spent", async () => {
    await spendBudget();
    expect((await statusGET(statusRequest(OWN_REF))).status).toBe(429);
  });

  it("never throttles repeated successful polls", async () => {
    for (let i = 0; i < LIMIT * 3; i++) {
      expect((await statusGET(statusRequest(OWN_REF))).status).toBe(200);
    }
  });

  it("keeps budgets per address", async () => {
    await spendBudget("198.51.100.7");
    expect((await statusGET(statusRequest(OWN_REF, "203.0.113.9"))).status).toBe(200);
  });

  it("does not count a database fault as a miss", async () => {
    readFails = "enrollments";
    for (let i = 0; i < LIMIT * 2; i++) {
      expect((await statusGET(statusRequest(OWN_REF))).status).toBe(404);
    }
    readFails = null;
    expect((await statusGET(statusRequest(OWN_REF))).status).toBe(200);
    expect(consoleError).toHaveBeenCalled();
  });

  it("does not look up the tenant for a spent address", async () => {
    await spendBudget();
    vi.mocked(resolveTenantId).mockClear();
    await statusGET(statusRequest(OWN_REF));
    expect(resolveTenantId).not.toHaveBeenCalled();
  });
});

describe("POST /api/public/telegram-link-token", () => {
  it("mints a link for a reference on this tenant", async () => {
    const res = await linkPOST(linkRequest(OWN_REF));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).deepLink).toMatch(/^https:\/\/t\.me\/own_bot\?start=/);
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toContainEqual(["id", "enr-own"]);
  });

  it("answers another tenant's reference as not found and writes no token", async () => {
    const other = await linkPOST(linkRequest(OTHER_TENANT_REF));
    const missing = await linkPOST(linkRequest("MISSING"));
    expect(other.status).toBe(404);
    expect(other.headers.get("Cache-Control")).toBe("no-store");
    expect(await other.json()).toEqual(await missing.json());
    expect(updates).toHaveLength(0);
  });

  it("refuses an address once its misses are spent, with Retry-After", async () => {
    for (let i = 0; i < LIMIT; i++) {
      expect((await linkPOST(linkRequest(`MISSING-${i}`))).status).toBe(404);
    }
    const res = await linkPOST(linkRequest(OWN_REF));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(updates).toHaveLength(0);
  });

  it("shares one budget with the status route", async () => {
    await spendBudget();
    expect((await linkPOST(linkRequest(OWN_REF))).status).toBe(429);
  });

  it("does not count a database fault as a miss", async () => {
    readFails = "enrollments";
    for (let i = 0; i < LIMIT * 2; i++) {
      expect((await linkPOST(linkRequest(OWN_REF))).status).toBe(404);
    }
    readFails = null;
    expect((await linkPOST(linkRequest(OWN_REF))).status).toBe(200);
  });

  it("stops when the tenant cannot be determined", async () => {
    vi.mocked(resolveTenantId).mockResolvedValue(
      NextResponse.json({ error: "Not Found" }, { status: 404 }),
    );
    const res = await linkPOST(linkRequest(OWN_REF));
    expect(res.status).toBe(404);
    expect(updates).toHaveLength(0);
  });
});
