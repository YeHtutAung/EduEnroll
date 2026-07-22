import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from "vitest";
import { Pool } from "pg";

// ─── Dashboard seat/ticket overview counts only OPEN intakes ────────────────
//
// A draft intake is not published and a closed one is over, so counting either
// reports capacity nobody can buy.
//
// This runs against the REAL database on purpose. The risk here is PostgREST
// join semantics, not our own arithmetic: a plain `intakes(status)` embed
// LEFT-joins and filters only the embedded object, so every class survives and
// the filter silently does nothing. Only `intakes!inner(status)` actually
// excludes rows — and a mocked client cannot tell those two apart, because both
// produce the same chain of calls.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

let tenantId = "";
const made = { tenants: [] as string[], intakes: [] as string[], classes: [] as string[] };

let seq = 0;
const uniq = () => `ds${Date.now().toString(36)}${seq++}`;

// requireAuth() is the only thing mocked: it hands the route a service-role
// client and a tenant id. The query the route then runs is entirely real.
vi.mock("@/lib/api", () => ({
  requireAuth: async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    return { supabase: createAdminClient(), tenantId };
  },
}));

/** An intake with no classes attached. */
async function makeEmptyIntake(status: "draft" | "open" | "closed") {
  const [i] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year, status)
     VALUES ($1, $2, 2026, $3::intake_status) RETURNING id`,
    [tenantId, `Empty ${status} ${uniq()}`, status],
  );
  made.intakes.push(i.id);
  return i.id;
}

async function makeIntake(status: "draft" | "open" | "closed", level: string) {
  const [i] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year, status)
     VALUES ($1, $2, 2026, $3::intake_status) RETURNING id`,
    [tenantId, `Intake ${status} ${uniq()}`, status],
  );
  made.intakes.push(i.id);
  const [c] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id,intake_id,level,fee_amount,seat_total,seat_remaining,status,
                          max_tickets_per_person)
     VALUES ($1,$2,$3,100,50,40,'open',10) RETURNING id`,
    [tenantId, i.id, level],
  );
  made.classes.push(c.id);
  return c.id;
}

const statsBody = async (): Promise<{ seats_by_class: { level: string }[]; has_open_intake: boolean }> => {
  const { GET } = await import("@/app/api/admin/stats/route");
  const res = await GET();
  const body = await res.json();
  // Surface the route's own error rather than dying on `undefined.map`, which
  // says nothing about which query failed.
  if (res.status !== 200 || !body.seats_by_class) {
    throw new Error(`stats route returned ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
};

const levelsInOverview = async (): Promise<string[]> =>
  (await statsBody()).seats_by_class.map((r) => r.level);

beforeAll(async () => {
  await pool.query("SELECT 1");
  const slug = uniq();
  const [t] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1,$2,'event') RETURNING id`,
    [`Stats ${slug}`, slug],
  );
  tenantId = t.id;
  made.tenants.push(t.id);

  // Warm PostgREST before the first assertion. The local gateway intermittently
  // answers the very first request with "An invalid response was received from
  // the upstream server", which surfaced as a ~1-in-5 failure of whichever test
  // ran first — nothing to do with the query under test. Kept deliberately
  // narrow: a cold-start warm-up, not a retry around the assertions, which
  // would mask a genuine 500.
  const { createAdminClient } = await import("@/lib/supabase/admin");
  await createAdminClient().from("tenants").select("id").limit(1);
});

afterEach(async () => {
  if (made.classes.length) {
    await sql(`DELETE FROM classes WHERE id = ANY($1::uuid[])`, [made.classes]);
    made.classes.length = 0;
  }
  if (made.intakes.length) {
    await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [made.intakes]);
    made.intakes.length = 0;
  }
});

afterAll(async () => {
  if (made.tenants.length) {
    await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [made.tenants]);
  }
  await pool.end();
});

describe("GET /api/admin/stats — seats_by_class respects intake status", () => {
  it("D1 includes a class in an open intake", async () => {
    await makeIntake("open", "LIVE-A");

    expect(await levelsInOverview()).toEqual(["LIVE-A"]);
  });

  it("D2 excludes a class in a draft intake", async () => {
    await makeIntake("draft", "DRAFT-A");

    expect(await levelsInOverview()).toEqual([]);
  });

  it("D3 excludes a class in a closed intake", async () => {
    await makeIntake("closed", "CLOSED-A");

    expect(await levelsInOverview()).toEqual([]);
  });

  it("D4 keeps only the open intake when all three coexist", async () => {
    // The case that matters: a left-joined embed returns all three here, so
    // this is what separates a real filter from one that does nothing.
    await makeIntake("open", "MIX-OPEN");
    await makeIntake("draft", "MIX-DRAFT");
    await makeIntake("closed", "MIX-CLOSED");

    expect(await levelsInOverview()).toEqual(["MIX-OPEN"]);
  });
});

describe("GET /api/admin/stats — has_open_intake disambiguates the empty overview", () => {
  // An empty seats_by_class has two causes needing different advice. Without
  // this flag the dashboard cannot tell them apart, and its empty state made
  // the stronger claim ("no open intake") in both cases — wrong in the second.

  it("D5 an OPEN intake with no classes reports empty seats but has_open_intake true", async () => {
    await makeEmptyIntake("open");

    const body = await statsBody();

    expect(body.seats_by_class).toEqual([]);
    expect(body.has_open_intake).toBe(true);
  });

  it("D6 only draft and closed intakes report has_open_intake false", async () => {
    await makeIntake("draft", "D6-DRAFT");
    await makeIntake("closed", "D6-CLOSED");

    const body = await statsBody();

    expect(body.seats_by_class).toEqual([]);
    expect(body.has_open_intake).toBe(false);
  });

  it("D7 no intakes at all reports has_open_intake false", async () => {
    const body = await statsBody();

    expect(body.seats_by_class).toEqual([]);
    expect(body.has_open_intake).toBe(false);
  });

  it("D8 an open intake WITH classes still reports has_open_intake true", async () => {
    // Guards against a flag that only ever reads true in the empty case.
    await makeIntake("open", "D8-OPEN");

    const body = await statsBody();

    expect(body.seats_by_class.map((r) => r.level)).toEqual(["D8-OPEN"]);
    expect(body.has_open_intake).toBe(true);
  });
});
