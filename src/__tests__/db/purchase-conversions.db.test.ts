import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

// ─── Server-side purchase conversions, against the REAL database ────────────
//
// The guarantees are a trigger on payments, a queue with a unique key, and a
// clean-up function. None of them exist in a mock. See
// docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Fixtures ────────────────────────────────────────────────────────────────

type Tracked = { tenants: string[]; intakes: string[]; classes: string[]; enrollments: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], enrollments: [] });
let seq = 0;
const uniq = () => `pcv${Date.now().toString(36)}${seq++}`;

type Settings = {
  meta?: string | null;
  tiktok?: string | null;
  rate?: number;
  enabled?: boolean;
  currency?: string;
};

async function makeWorld(opts: { settings?: Settings | null } = {}) {
  const settings = opts.settings === undefined ? {} : opts.settings;
  const slug = uniq();
  const [t] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1,$2,'event') RETURNING id`,
    [`PCV ${slug}`, slug],
  );
  made.tenants.push(t.id);
  if (settings) {
    const {
      meta = "111111111111111",
      tiktok = "TTPIXELCODE",
      rate = 0.0005,
      enabled = true,
      currency = "USD",
    } = settings;
    await sql(
      `INSERT INTO tenant_conversion_settings
         (tenant_id, config_id, meta_pixel_id, tiktok_pixel_code, report_currency, report_rate, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [t.id, "TEST_" + slug.toUpperCase(), meta, tiktok, currency, rate, enabled],
    );
  }
  const [i] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1,'PCV intake',2026) RETURNING id`,
    [t.id],
  );
  made.intakes.push(i.id);
  const [c] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id,intake_id,level,fee_amount,seat_total,seat_remaining,status,
                          max_tickets_per_person)
     VALUES ($1,$2,$3,50000,50,40,'open',10) RETURNING id`,
    [t.id, i.id, `L${uniq()}`],
  );
  made.classes.push(c.id);
  const [e] = await sql<{ id: string; enrollment_ref: string }>(
    `INSERT INTO enrollments (enrollment_ref,tenant_id,student_name_en,phone,class_id,quantity,status)
     VALUES ('',$1,'PCV Test','09000000000',$2,1,'pending_payment') RETURNING id, enrollment_ref`,
    [t.id, c.id],
  );
  made.enrollments.push(e.id);
  return { tenantId: t.id, enrollmentId: e.id, enrollmentRef: e.enrollment_ref };
}

/** A pending bank-transfer payment, ready to be verified. */
async function seedPayment(
  enrollmentId: string,
  tenantId: string,
  opts: {
    amount?: number;
    fee?: number;
    received?: number | null;
    providerCurrency?: string | null;
  } = {},
) {
  const { amount = 50000, fee = 0, received = null, providerCurrency = null } = opts;
  const [p] = await sql<{ id: string }>(
    `INSERT INTO payments (enrollment_id, tenant_id, amount, platform_fee, payment_ref,
                           payment_method, status, received_amount, provider_currency)
     VALUES ($1,$2,$3,$4,$5,'bank_transfer','pending',$6,$7) RETURNING id`,
    [enrollmentId, tenantId, amount, fee, `PCV_${uniq()}`, received, providerCurrency],
  );
  return p.id;
}

const setStatus = (paymentId: string, status: string) =>
  sql(`UPDATE payments SET status = $2::payment_status WHERE id = $1`, [paymentId, status]);

/**
 * Change a payment's status on a dedicated connection and return the server
 * notices it raised. The trigger body swallows its own errors into a WARNING,
 * so "no row was added" cannot tell a working guard from a swallowed error:
 * the tests that expect no row also assert that no such warning was raised.
 */
const FAILED_WARNING = /enqueue failed/;
async function setStatusWithNotices(paymentId: string, status: string) {
  const notices: string[] = [];
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  client.on("notice", (n) => notices.push(n.message ?? ""));
  await client.connect();
  try {
    await client.query(`UPDATE payments SET status = $2::payment_status WHERE id = $1`, [
      paymentId,
      status,
    ]);
  } finally {
    await client.end();
  }
  return notices;
}
const expectNoFailureWarning = (notices: string[]) =>
  expect(notices.filter((m) => FAILED_WARNING.test(m))).toEqual([]);

type EventRow = {
  platform: string;
  status: string;
  value: string;
  currency: string;
  event_id: string;
  attempts: number;
};
const eventsOf = (enrollmentId: string) =>
  sql<EventRow>(
    `SELECT platform, status, value::text, currency, event_id, attempts
       FROM conversion_events WHERE enrollment_id = $1 ORDER BY platform`,
    [enrollmentId],
  );

const seedContext = async (enrollmentId: string, createdAt?: string) =>
  sql(
    `INSERT INTO enrollment_ad_context (enrollment_id, fbp, ttclid, source_url, created_at)
     VALUES ($1,'fb.1.1.1','tt123','https://x.example/enroll/y', COALESCE($2::timestamptz, now()))`,
    [enrollmentId, createdAt ?? null],
  );
const hasContext = async (enrollmentId: string) =>
  (await sql(`SELECT 1 FROM enrollment_ad_context WHERE enrollment_id = $1`, [enrollmentId])).length === 1;

const seedEvent = (
  enrollmentId: string,
  tenantId: string,
  platform: "meta" | "tiktok",
  status: string,
  occurredAt?: string,
) =>
  sql(
    `INSERT INTO conversion_events (enrollment_id, tenant_id, platform, event_id, value, currency,
                                    status, occurred_at)
     VALUES ($1,$2,$3,$4,10,'USD',$5, COALESCE($6::timestamptz, now()))`,
    [enrollmentId, tenantId, platform, `ev_${uniq()}`, status, occurredAt ?? null],
  );

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1");
});

afterEach(async () => {
  const { tenants, intakes, classes, enrollments } = made;
  if (enrollments.length) {
    await sql(`DELETE FROM tickets  WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM payments WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    // Cascades to conversion_events and enrollment_ad_context.
    await sql(`DELETE FROM enrollments WHERE id = ANY($1::uuid[])`, [enrollments]);
  }
  if (classes.length) await sql(`DELETE FROM classes WHERE id = ANY($1::uuid[])`, [classes]);
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  // Cascades to tenant_conversion_settings.
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

// ─── The enqueue trigger ────────────────────────────────────────────────────

describe("enqueue trigger", () => {
  it("adds one row per configured platform when a payment becomes verified", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const pid = await seedPayment(enrollmentId, tenantId, { amount: 50000, fee: 0 });

    expect(await eventsOf(enrollmentId)).toEqual([]);
    await setStatus(pid, "verified");

    const rows = await eventsOf(enrollmentId);
    expect(rows.map((r) => r.platform)).toEqual(["meta", "tiktok"]);
    for (const r of rows) {
      expect(r.status).toBe("pending");
      expect(Number(r.value)).toBe(25);
      expect(r.currency).toBe("USD");
      expect(r.attempts).toBe(0);
    }
  });

  it("takes the platform fee off the value", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: { rate: 1 } });
    const pid = await seedPayment(enrollmentId, tenantId, { amount: 50300, fee: 300 });
    await setStatus(pid, "verified");
    expect((await eventsOf(enrollmentId)).map((r) => Number(r.value))).toEqual([50000, 50000]);
  });

  it("adds only the configured platform when one pixel is null", async () => {
    const a = await makeWorld({ settings: { tiktok: null } });
    await setStatus(await seedPayment(a.enrollmentId, a.tenantId), "verified");
    expect((await eventsOf(a.enrollmentId)).map((r) => r.platform)).toEqual(["meta"]);

    const b = await makeWorld({ settings: { meta: null } });
    await setStatus(await seedPayment(b.enrollmentId, b.tenantId), "verified");
    expect((await eventsOf(b.enrollmentId)).map((r) => r.platform)).toEqual(["tiktok"]);
  });

  it("adds nothing on a second transition to verified", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const pid = await seedPayment(enrollmentId, tenantId);
    await setStatus(pid, "verified");
    expect(await eventsOf(enrollmentId)).toHaveLength(2);

    await setStatus(pid, "pending");
    const notices = await setStatusWithNotices(pid, "verified");

    expect(await eventsOf(enrollmentId)).toHaveLength(2);
    expectNoFailureWarning(notices);
  });

  it("adds nothing for an unconfigured tenant", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: null });
    const pid = await seedPayment(enrollmentId, tenantId);
    const notices = await setStatusWithNotices(pid, "verified");
    expect(await eventsOf(enrollmentId)).toEqual([]);
    expectNoFailureWarning(notices);
  });

  it("adds nothing for a disabled tenant", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: { enabled: false } });
    const pid = await seedPayment(enrollmentId, tenantId);
    const notices = await setStatusWithNotices(pid, "verified");
    expect(await eventsOf(enrollmentId)).toEqual([]);
    expectNoFailureWarning(notices);
  });

  it("adds nothing when the value is zero", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: { rate: 1 } });
    const pid = await seedPayment(enrollmentId, tenantId, { amount: 100, fee: 100 });
    const notices = await setStatusWithNotices(pid, "verified");
    expect(await eventsOf(enrollmentId)).toEqual([]);
    expectNoFailureWarning(notices);
  });

  it("adds nothing when the converted value rounds to zero", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: { rate: 0.0005 } });
    const pid = await seedPayment(enrollmentId, tenantId, { amount: 1, fee: 0 });
    const notices = await setStatusWithNotices(pid, "verified");
    expect(await eventsOf(enrollmentId)).toEqual([]);
    expectNoFailureWarning(notices);
  });

  it("keeps the queued value when the rate changes later", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const pid = await seedPayment(enrollmentId, tenantId);
    await setStatus(pid, "verified");

    await sql(`UPDATE tenant_conversion_settings SET report_rate = 0.5 WHERE tenant_id = $1`, [
      tenantId,
    ]);

    expect((await eventsOf(enrollmentId)).map((r) => Number(r.value))).toEqual([25, 25]);
  });

  it("requires a rate", async () => {
    const { tenantId } = await makeWorld({ settings: null });
    const insert = (rate: string | null) =>
      sql(
        `INSERT INTO tenant_conversion_settings (tenant_id, config_id, meta_pixel_id, report_rate)
         VALUES ($1,'NORATE',$2,${rate === null ? "DEFAULT" : rate})`,
        [tenantId, "111"],
      );
    // Omitted: NOT NULL with no default.
    await expect(insert(null)).rejects.toThrow(/report_rate/);
    // Zero, and negative: the CHECK.
    await expect(insert("0")).rejects.toThrow(/report_rate/);
    await expect(insert("-1")).rejects.toThrow(/report_rate/);
  });

  it("skips a charge in another currency", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const pid = await seedPayment(enrollmentId, tenantId, { providerCurrency: "sgd" });
    const notices = await setStatusWithNotices(pid, "verified");
    expect(await eventsOf(enrollmentId)).toEqual([]);
    expectNoFailureWarning(notices);
  });

  it("still queues a charge in the tenant's own currency, whatever the case", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const pid = await seedPayment(enrollmentId, tenantId, { providerCurrency: "mmk" });
    await setStatus(pid, "verified");
    expect(await eventsOf(enrollmentId)).toHaveLength(2);
  });

  it("reports the full total for a top-up", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: { rate: 1 } });
    // Row A recorded the partial payment and holds the full ticket total.
    await seedPayment(enrollmentId, tenantId, { amount: 1000, received: 600 });
    // Row B is the top-up: only the remainder.
    const b = await seedPayment(enrollmentId, tenantId, { amount: 400 });
    await setStatus(b, "verified");

    expect((await eventsOf(enrollmentId)).map((r) => Number(r.value))).toEqual([1000, 1000]);
  });

  it("removes the platform fee from a top-up's full total", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: { rate: 1 } });
    await seedPayment(enrollmentId, tenantId, { amount: 1030, fee: 30, received: 600 });
    const b = await seedPayment(enrollmentId, tenantId, { amount: 430 });
    await setStatus(b, "verified");

    expect((await eventsOf(enrollmentId)).map((r) => Number(r.value))).toEqual([1000, 1000]);
  });

  // The FIRST partial row holds the full total. A later partial row holds a
  // smaller remainder and must not be picked.
  it("takes the value from the first partial row when there are repeated partials", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: { rate: 1 } });
    await seedPayment(enrollmentId, tenantId, { amount: 1000, received: 600 }); // A
    await seedPayment(enrollmentId, tenantId, { amount: 400, received: 150 }); // B, also partial
    const c = await seedPayment(enrollmentId, tenantId, { amount: 250 }); // C, the final top-up
    await setStatus(c, "verified");

    expect((await eventsOf(enrollmentId)).map((r) => Number(r.value))).toEqual([1000, 1000]);
  });

  // Approving the first partial row itself: a newer partial row must not
  // replace its own full value.
  it("uses the rows own total when it is approved while a newer partial row exists", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: { rate: 1 } });
    const a = await seedPayment(enrollmentId, tenantId, { amount: 1000, received: 600 });
    await seedPayment(enrollmentId, tenantId, { amount: 400, received: 150 });
    await setStatus(a, "verified");

    expect((await eventsOf(enrollmentId)).map((r) => Number(r.value))).toEqual([1000, 1000]);
  });

  it("stores an event id that is the hash of the enrollment id", async () => {
    const { tenantId, enrollmentId, enrollmentRef } = await makeWorld();
    await setStatus(await seedPayment(enrollmentId, tenantId), "verified");

    const expected = createHash("sha256").update(`purchase:${enrollmentId}`).digest("hex");
    const rows = await eventsOf(enrollmentId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.event_id).toBe(expected);
      if (enrollmentRef) expect(r.event_id).not.toContain(enrollmentRef);
    }
  });

  // A conversion bug must never roll back a settlement. The failure is forced
  // with a CHECK on conversion_events that no row can satisfy, so the INSERT
  // inside the trigger body raises. Everything runs in ONE transaction on ONE
  // connection that is always rolled back, so the CHECK is never committed and
  // can never be seen by, or leak into, another test or another session.
  it("does not roll back the payment when the trigger body fails", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const pid = await seedPayment(enrollmentId, tenantId);

    const client = new Client({ connectionString: process.env.DATABASE_URL });
    const notices: string[] = [];
    client.on("notice", (n) => notices.push(n.message ?? ""));
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        `ALTER TABLE conversion_events
           ADD CONSTRAINT tmp_force_trigger_failure CHECK (false) NOT VALID`,
      );

      // The CHECK really is in force: a direct insert fails.
      await client.query("SAVEPOINT direct");
      await expect(
        client.query(
          `INSERT INTO conversion_events (enrollment_id, tenant_id, platform, event_id, value, currency)
           VALUES ($1,$2,'meta','x',1,'USD')`,
          [enrollmentId, tenantId],
        ),
      ).rejects.toThrow(/tmp_force_trigger_failure/);
      await client.query("ROLLBACK TO SAVEPOINT direct");

      // The verification must succeed despite the trigger body raising.
      await client.query(`UPDATE payments SET status = 'verified' WHERE id = $1`, [pid]);

      const pay = await client.query(`SELECT status FROM payments WHERE id = $1`, [pid]);
      expect(pay.rows[0].status).toBe("verified");
      const enr = await client.query(`SELECT status FROM enrollments WHERE id = $1`, [enrollmentId]);
      expect(enr.rows[0].status).toBe("confirmed");
      const ev = await client.query(
        `SELECT count(*)::int AS n FROM conversion_events WHERE enrollment_id = $1`,
        [enrollmentId],
      );
      expect(ev.rows[0].n).toBe(0);
      // The error was swallowed into a warning, not silently skipped.
      expect(notices.filter((m) => FAILED_WARNING.test(m))).toHaveLength(1);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }

    // Nothing leaked: the CHECK is gone and the rolled-back verification left
    // the payment as it was seeded.
    const leaked = await sql(
      `SELECT 1 FROM pg_constraint WHERE conname = 'tmp_force_trigger_failure'`,
    );
    expect(leaked).toEqual([]);
    expect((await sql<{ status: string }>(`SELECT status FROM payments WHERE id=$1`, [pid]))[0].status)
      .toBe("pending");
  });
});

// ─── cleanup_conversion_data ────────────────────────────────────────────────

describe("cleanup_conversion_data", () => {
  const cleanup = () =>
    sql<{ expired: number; context_deleted: number }>(`SELECT * FROM cleanup_conversion_data()`);
  const statusOf = async (enrollmentId: string, platform: string) =>
    (
      await sql<{ status: string; last_error: string | null }>(
        `SELECT status, last_error FROM conversion_events WHERE enrollment_id=$1 AND platform=$2`,
        [enrollmentId, platform],
      )
    )[0];

  it("expires pending rows older than 7 days and deletes their context", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: null });
    await seedContext(enrollmentId);
    await seedEvent(enrollmentId, tenantId, "meta", "pending", daysAgo(8));
    await seedEvent(enrollmentId, tenantId, "tiktok", "pending", daysAgo(8));

    const [r] = await cleanup();

    expect(r.expired).toBeGreaterThanOrEqual(2);
    expect(r.context_deleted).toBeGreaterThanOrEqual(1);
    expect(await statusOf(enrollmentId, "meta")).toEqual({ status: "failed", last_error: "expired" });
    expect(await statusOf(enrollmentId, "tiktok")).toEqual({ status: "failed", last_error: "expired" });
    expect(await hasContext(enrollmentId)).toBe(false);
  });

  it("does not expire a pending row younger than 7 days", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: null });
    await seedContext(enrollmentId);
    await seedEvent(enrollmentId, tenantId, "meta", "pending", daysAgo(6));

    await cleanup();

    expect((await statusOf(enrollmentId, "meta")).status).toBe("pending");
    expect(await hasContext(enrollmentId)).toBe(true);
  });

  it("keeps context while a pending row exists", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: null });
    await seedContext(enrollmentId);
    await seedEvent(enrollmentId, tenantId, "meta", "sent");
    await seedEvent(enrollmentId, tenantId, "tiktok", "pending");

    await cleanup();

    expect(await hasContext(enrollmentId)).toBe(true);
  });

  it("deletes context once every row is finished", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: null });
    await seedContext(enrollmentId);
    await seedEvent(enrollmentId, tenantId, "meta", "sent");
    await seedEvent(enrollmentId, tenantId, "tiktok", "skipped");

    await cleanup();

    expect(await hasContext(enrollmentId)).toBe(false);
    // The queue rows themselves are kept.
    expect(await eventsOf(enrollmentId)).toHaveLength(2);
  });

  it("deletes context older than 8 days with no queue rows", async () => {
    const { enrollmentId } = await makeWorld({ settings: null });
    await seedContext(enrollmentId, daysAgo(9));

    await cleanup();

    expect(await hasContext(enrollmentId)).toBe(false);
  });

  it("keeps context older than 8 days while a queue row is still pending", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ settings: null });
    await seedContext(enrollmentId, daysAgo(9));
    await seedEvent(enrollmentId, tenantId, "meta", "pending");

    await cleanup();

    expect((await statusOf(enrollmentId, "meta")).status).toBe("pending");
    expect(await hasContext(enrollmentId)).toBe(true);
  });

  it("keeps context younger than 8 days with no queue rows", async () => {
    const { enrollmentId } = await makeWorld({ settings: null });
    await seedContext(enrollmentId, daysAgo(7));

    await cleanup();

    expect(await hasContext(enrollmentId)).toBe(true);
  });
});

// ─── Privileges ─────────────────────────────────────────────────────────────
//
// The harness (src/__tests__/db/setup.ts, section 3) grants full DML on every
// public table to anon/authenticated/service_role to mirror hosted Supabase,
// so has_table_privilege() cannot show the migration's REVOKE here: it is
// undone before any test runs. What the migration really relies on is RLS with
// no policies, which the harness grant cannot undo. So this checks RLS is on,
// no policy exists, and anon/authenticated see and write nothing even with the
// harness grant in place. The owner checks has_table_privilege on the dev and
// production databases after the migration (spec, Testing).
const TABLES = ["tenant_conversion_settings", "enrollment_ad_context", "conversion_events"];

describe("privileges", () => {
  it.each(TABLES)("%s has RLS on and no policies", async (table) => {
    const [c] = await sql<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || $1)::regclass`,
      [table],
    );
    expect(c.relrowsecurity).toBe(true);
    const policies = await sql(`SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=$1`, [
      table,
    ]);
    expect(policies).toEqual([]);
  });

  it.each(["anon", "authenticated"])("%s can read and write none of the tables", async (role) => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedContext(enrollmentId);
    await seedEvent(enrollmentId, tenantId, "meta", "pending");

    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      for (const table of TABLES) {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        const seen = await client.query(`SELECT 1 FROM public.${table}`);
        expect(seen.rowCount).toBe(0);
        await client.query("ROLLBACK");
      }
      // Writes fail too, whether by privilege or by row security.
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      await expect(
        client.query(`DELETE FROM public.conversion_events WHERE enrollment_id = $1 RETURNING 1`, [
          enrollmentId,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      await expect(
        client.query(
          `INSERT INTO public.conversion_events (enrollment_id, tenant_id, platform, event_id, value, currency)
           VALUES ($1,$2,'tiktok','x',1,'USD')`,
          [enrollmentId, tenantId],
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
    // The service role (the app's key) still gets through RLS in a real
    // deployment via BYPASSRLS; here the pool is the table owner.
    expect(await eventsOf(enrollmentId)).toHaveLength(1);
  });

  it("the migration revokes table access from public, anon and authenticated", () => {
    const file = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20261103120000_purchase_conversions.sql"),
      "utf8",
    );
    for (const table of TABLES) {
      expect(file).toMatch(
        new RegExp(`REVOKE ALL ON public\\.${table} FROM public, anon, authenticated`),
      );
    }
  });

  it.each(["fn_payments_enqueue_conversions()", "cleanup_conversion_data()"])(
    "does not let anon or authenticated run %s",
    async (fn) => {
      const [r] = await sql<{ anon: boolean; authed: boolean; pub: boolean }>(
        `SELECT has_function_privilege('anon', 'public.${fn}', 'EXECUTE') AS anon,
                has_function_privilege('authenticated', 'public.${fn}', 'EXECUTE') AS authed,
                has_function_privilege('public', 'public.${fn}', 'EXECUTE') AS pub`,
      );
      expect(r).toEqual({ anon: false, authed: false, pub: false });
    },
  );

  it("defines both functions as SECURITY DEFINER with a pinned search_path", async () => {
    const rows = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT proname, prosecdef, proconfig FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('fn_payments_enqueue_conversions','cleanup_conversion_data')
        ORDER BY proname`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.proname, r]));
    expect(Object.keys(byName).sort()).toEqual([
      "cleanup_conversion_data",
      "fn_payments_enqueue_conversions",
    ]);
    for (const r of rows) expect(r.prosecdef).toBe(true);
    expect(byName.cleanup_conversion_data.proconfig).toEqual(["search_path=public, pg_temp"]);
    expect([...(byName.fn_payments_enqueue_conversions.proconfig ?? [])].sort()).toEqual([
      "lock_timeout=1s",
      "search_path=public, pg_temp",
    ]);
  });

  it("lets service_role run the clean-up function", async () => {
    const [r] = await sql<{ ok: boolean }>(
      `SELECT has_function_privilege('service_role', 'public.cleanup_conversion_data()', 'EXECUTE') AS ok`,
    );
    expect(r.ok).toBe(true);
  });
});
