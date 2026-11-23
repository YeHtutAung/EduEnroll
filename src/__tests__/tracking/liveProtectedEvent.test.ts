import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

// Decision 8 (2026-11-23): tenant tag scripts are off on the whole host while
// the tenant has a live protected event. "Live" is move_order_buyer's end rule
// (20261122130000_leaders_phone.sql): the intake's last day is
// max(greatest(event_date, coalesce(end_time, event_date))) over its classes;
// it has ended when that day is before today in Asia/Yangon; no date = live.

const env = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  tenant: { name: "Sky", logo_url: null, org_type: "event" } as Record<string, unknown> | null,
  gtm: { data: { gtm_container_id: "GTM-ABC123" } as unknown, error: null as unknown },
  intakes: { data: [] as unknown, error: null as unknown, throws: false },
  intakeQueries: 0,
  lastIntakeQuery: null as { columns: string; filters: [string, unknown][] } | null,
}));

vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => env.headers.get(k) ?? null }),
}));

function fakeAdmin() {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let columns = "";
      const builder: Record<string, unknown> = {
        select(cols: string) {
          columns = cols;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return builder;
        },
        maybeSingle() {
          if (table !== "tenants") throw new Error(`unexpected maybeSingle on ${table}`);
          if (columns.trim() === "gtm_container_id") return Promise.resolve(env.gtm);
          return Promise.resolve({ data: env.tenant, error: null });
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          if (table !== "intakes") return Promise.reject(new Error(`unexpected await on ${table}`)).then(resolve, reject);
          env.intakeQueries++;
          env.lastIntakeQuery = { columns, filters: [...filters] };
          if (env.intakes.throws) return Promise.reject(new Error("network")).then(resolve, reject);
          return Promise.resolve({ data: env.intakes.data, error: env.intakes.error }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));

import {
  isLiveProtected,
  lastEventDay,
  tenantHasLiveProtectedEvent,
  type ProtectedIntakeRow,
} from "@/server/tickets/liveProtectedEvent";
import PublicLayout from "@/app/(public)/layout";
import TenantTagManager from "@/components/tracking/TenantTagManager";
import AdClickCapture from "@/components/tracking/AdClickCapture";

// 2026-11-23 10:00 in Yangon (UTC+6:30) is 03:30 UTC.
const NOW = new Date("2026-11-23T03:30:00Z");

const row = (
  classes: { event_date: string | null; end_time: string | null }[] | null,
  ticket_protection = true,
): ProtectedIntakeRow => ({ ticket_protection, classes });

describe("isLiveProtected (pure)", () => {
  it("no protected intake → false", () => {
    expect(isLiveProtected([], NOW)).toBe(false);
  });

  it("a protected intake whose event ends tomorrow → true", () => {
    expect(isLiveProtected([row([{ event_date: "2026-11-24", end_time: null }])], NOW)).toBe(true);
  });

  it("a multi-day event that started yesterday and ends tomorrow (end_time is the END DATE) → true", () => {
    expect(isLiveProtected([row([{ event_date: "2026-11-22", end_time: "2026-11-24" }])], NOW)).toBe(true);
  });

  it("an event on today's date (Yangon) is still live", () => {
    expect(isLiveProtected([row([{ event_date: "2026-11-23", end_time: null }])], NOW)).toBe(true);
    // 23:59 Yangon on the 23rd is still the 23rd, though UTC is too.
    expect(isLiveProtected([row([{ event_date: "2026-11-23", end_time: null }])], new Date("2026-11-23T17:29:00Z"))).toBe(true);
  });

  it("the day after, in Yangon, it has ended, though UTC is still on the event day", () => {
    // 2026-11-23 18:00 UTC is 2026-11-24 00:30 in Yangon.
    expect(isLiveProtected([row([{ event_date: "2026-11-23", end_time: null }])], new Date("2026-11-23T18:00:00Z"))).toBe(false);
  });

  it("a protected intake whose events have all ended → false", () => {
    expect(
      isLiveProtected(
        [row([
          { event_date: "2026-11-20", end_time: "2026-11-22" },
          { event_date: "2026-11-01", end_time: null },
        ])],
        NOW,
      ),
    ).toBe(false);
  });

  it("a protected intake with no date → true", () => {
    expect(isLiveProtected([row([{ event_date: null, end_time: null }])], NOW)).toBe(true);
    expect(isLiveProtected([row([])], NOW)).toBe(true);
    expect(isLiveProtected([row(null)], NOW)).toBe(true);
  });

  it("one live protected intake among ended ones → true", () => {
    expect(
      isLiveProtected(
        [row([{ event_date: "2026-11-01", end_time: null }]), row([{ event_date: "2026-12-01", end_time: null }])],
        NOW,
      ),
    ).toBe(true);
  });

  it("an unprotected intake with a future event → false", () => {
    expect(isLiveProtected([row([{ event_date: "2026-12-31", end_time: null }], false)], NOW)).toBe(false);
  });
});

describe("lastEventDay follows greatest(event_date, coalesce(end_time, event_date))", () => {
  it("takes the end date when it is later, and the start when the end is earlier", () => {
    expect(lastEventDay([{ event_date: "2026-11-20", end_time: "2026-11-22" }])).toBe("2026-11-22");
    expect(lastEventDay([{ event_date: "2026-11-20", end_time: "2026-11-18" }])).toBe("2026-11-20");
  });

  it("counts an end date with no start, as greatest() skips NULLs", () => {
    expect(lastEventDay([{ event_date: null, end_time: "2026-11-22" }])).toBe("2026-11-22");
  });

  it("is the latest across classes, and null with no date", () => {
    expect(
      lastEventDay([
        { event_date: "2026-11-20", end_time: null },
        { event_date: null, end_time: null },
        { event_date: "2026-11-25", end_time: null },
      ]),
    ).toBe("2026-11-25");
    expect(lastEventDay([{ event_date: null, end_time: null }])).toBeNull();
  });
});

describe("tenantHasLiveProtectedEvent", () => {
  beforeEach(() => {
    env.intakes = { data: [], error: null, throws: false };
  });

  it("no protected intake → false", async () => {
    await expect(tenantHasLiveProtectedEvent(fakeAdmin() as never, "sky", NOW)).resolves.toBe(false);
  });

  it("asks, in one query, for this tenant's protected intakes and their classes' dates", async () => {
    await tenantHasLiveProtectedEvent(fakeAdmin() as never, "sky", NOW);
    expect(env.lastIntakeQuery?.filters).toEqual([
      ["ticket_protection", true],
      ["tenants.subdomain", "sky"],
    ]);
    expect(env.lastIntakeQuery?.columns).toContain("classes(event_date, end_time)");
    expect(env.lastIntakeQuery?.columns).toContain("tenants!inner(subdomain)");
  });

  it("a live protected intake → true", async () => {
    env.intakes.data = [row([{ event_date: "2026-11-24", end_time: null }])];
    await expect(tenantHasLiveProtectedEvent(fakeAdmin() as never, "sky", NOW)).resolves.toBe(true);
  });

  it("a read error → true (fail closed)", async () => {
    env.intakes.error = { code: "42703", message: "column does not exist" };
    await expect(tenantHasLiveProtectedEvent(fakeAdmin() as never, "sky", NOW)).resolves.toBe(true);
  });

  it("a thrown error → true, never a rejection", async () => {
    env.intakes.throws = true;
    await expect(tenantHasLiveProtectedEvent(fakeAdmin() as never, "sky", NOW)).resolves.toBe(true);
  });

  it("an odd answer (no array) → true", async () => {
    env.intakes.data = null;
    await expect(tenantHasLiveProtectedEvent(fakeAdmin() as never, "sky", NOW)).resolves.toBe(true);
  });
});

// ─── The layout ──────────────────────────────────────────────────────────────

function findAll(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, type, out);
  return out;
}

async function renderLayout() {
  const tree = await PublicLayout({ children: "page" });
  const tm = findAll(tree, TenantTagManager);
  const ac = findAll(tree, AdClickCapture);
  expect(tm).toHaveLength(1);
  expect(ac).toHaveLength(1);
  return {
    tree,
    tagManager: (tm[0].props as { containerId: string | null }).containerId,
    adClick: (ac[0].props as { containerId: string | null }).containerId,
  };
}

describe("PublicLayout: tags off while a protected event is live", () => {
  beforeEach(() => {
    env.headers = new Map([
      ["x-tenant-slug", "sky"],
      ["host", "sky.kuunyi.test"],
    ]);
    env.tenant = { name: "Sky", logo_url: null, org_type: "event" };
    env.gtm = { data: { gtm_container_id: "GTM-ABC123" }, error: null };
    env.intakes = { data: [], error: null, throws: false };
    env.intakeQueries = 0;
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("GTM_ALLOW_NON_PRODUCTION", "true");
  });

  it("no protected event: tags unchanged (on, as gtmAllowedOnHost decides)", async () => {
    const r = await renderLayout();
    expect(r.tagManager).toBe("GTM-ABC123");
    expect(r.adClick).toBe("GTM-ABC123");
  });

  it("an ended protected event: tags on", async () => {
    env.intakes.data = [row([{ event_date: "2020-01-01", end_time: null }])];
    const r = await renderLayout();
    expect(r.tagManager).toBe("GTM-ABC123");
  });

  it("a live protected event: both TenantTagManager and AdClickCapture off", async () => {
    env.intakes.data = [row([{ event_date: "2099-01-01", end_time: null }])];
    const r = await renderLayout();
    expect(r.tagManager).toBeNull();
    expect(r.adClick).toBeNull();
  });

  it("the protection read fails: tags off, and the page still renders", async () => {
    env.intakes.throws = true;
    const r = await renderLayout();
    expect(r.tagManager).toBeNull();
    expect(r.adClick).toBeNull();
    expect(JSON.stringify(r.tree)).toContain("page");
  });

  it("a read error answer: tags off, and the header still has the tenant name", async () => {
    env.intakes.error = { message: "boom" };
    const r = await renderLayout();
    expect(r.tagManager).toBeNull();
    expect(JSON.stringify(r.tree)).toContain("Sky");
  });

  it("tags already off by gtmAllowedOnHost: unchanged, and no protection query", async () => {
    vi.stubEnv("GTM_ALLOW_NON_PRODUCTION", "false");
    const r = await renderLayout();
    expect(r.tagManager).toBeNull();
    expect(env.intakeQueries).toBe(0);
  });

  it("no container configured: no protection query", async () => {
    env.gtm = { data: { gtm_container_id: null }, error: null };
    const r = await renderLayout();
    expect(r.tagManager).toBeNull();
    expect(env.intakeQueries).toBe(0);
  });
});
