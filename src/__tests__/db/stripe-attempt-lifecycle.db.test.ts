import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Pool, Client } from "pg";
import fs from "fs";
import path from "path";

// ─── Stripe attempt lifecycle: real database, real RPC (Plan v18 §1c) ───────
// The finalizer is a SECURITY DEFINER function whose whole job is concurrency
// and identity enforcement — mocks cannot test it. Requires the isolated
// local stack; see setup.ts for the local-only guards.
//
// L-tests exercise finalize_stripe_payment_attempt() as shipped in
// 20260722180000_stripe_settlement_contract.sql. M-tests replay the SHIPPED
// migration file inside a rolled-back transaction against synthetic
// pre-migration state, so what is tested is the artifact, not a copy.

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260722180000_stripe_settlement_contract.sql",
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Fixture tracking (ids recorded at creation, never at teardown) ──────────
type Tracked = { tenants: string[]; intakes: string[]; classes: string[]; enrollments: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], enrollments: [] });

let seq = 0;
const uniq = () => `sal${Date.now().toString(36)}${seq++}`;

async function createTenant(): Promise<string> {
  const slug = uniq();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain) VALUES ($1, $2) RETURNING id`,
    [`Test ${slug}`, slug],
  );
  made.tenants.push(row.id);
  return row.id;
}

async function createEnrollment(tenantId: string, status = "pending_payment"): Promise<string> {
  const [intake] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1, 'SAL intake', 2026) RETURNING id`,
    [tenantId],
  );
  made.intakes.push(intake.id);
  const [cls] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining, status)
     VALUES ($1, $2, $3, 100, 10, 7, 'open') RETURNING id`,
    [tenantId, intake.id, `L${uniq()}`],
  );
  made.classes.push(cls.id);
  const [enr] = await sql<{ id: string }>(
    `INSERT INTO enrollments
       (enrollment_ref, tenant_id, student_name_en, phone, class_id, quantity, status)
     VALUES ('', $1, 'SAL Student', '09000000000', $2, 1, $3::enrollment_status) RETURNING id`,
    [tenantId, cls.id, status],
  );
  made.enrollments.push(enr.id);
  return enr.id;
}

type FinalizeArgs = {
  enrollmentId: string;
  tenantId: string;
  flow?: string;
  attempt: number;
  intentId?: string | null;
  sessionId?: string | null;
  amount?: number;
  minor?: number;
  currency?: string;
  predecessorId?: string | null;
};

const FINALIZE = `SELECT * FROM public.finalize_stripe_payment_attempt(
  $1::uuid, $2::uuid, $3::text, $4::int, $5::text, $6::text,
  $7::numeric, $8::bigint, $9::text, $10::uuid)`;

function args(a: FinalizeArgs): unknown[] {
  return [
    a.enrollmentId, a.tenantId, a.flow ?? "direct_payment_intent", a.attempt,
    a.intentId === undefined ? `pi_${uniq()}` : a.intentId,
    a.sessionId === undefined ? null : a.sessionId,
    a.amount ?? 100, a.minor ?? (a.amount ?? 100) * 100,
    a.currency ?? "sgd", a.predecessorId ?? null,
  ];
}

async function finalize(a: FinalizeArgs) {
  return (await sql(FINALIZE, args(a)))[0];
}

/** Expect the finalizer to raise with the given SQLSTATE; returns the error. */
async function finalizeFails(a: FinalizeArgs, code: string) {
  try {
    await finalize(a);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    expect(err.code, `expected ${code}, got ${err.code}: ${err.message}`).toBe(code);
    return err;
  }
  throw new Error(`expected finalize to raise ${code}, but it returned`);
}

const paymentsFor = async (enrollmentId: string) =>
  sql(`SELECT * FROM payments WHERE enrollment_id = $1 ORDER BY attempt_seq NULLS FIRST, created_at`, [enrollmentId]);

const activeStripeCount = async (enrollmentId: string) =>
  Number((await sql<{ n: string }>(
    `SELECT count(*) n FROM payments
      WHERE enrollment_id = $1 AND payment_method = 'stripe'
        AND status IN ('awaiting_payment','pending')`, [enrollmentId]))[0].n);

beforeEach(() => { made = fresh(); });

afterEach(async () => {
  // FK order: conflicts reference payments/enrollments with SET NULL, so
  // payments cascade via enrollment delete; then classes/intakes/tenants.
  for (const id of made.enrollments) await sql(`DELETE FROM enrollments WHERE id = $1`, [id]);
  for (const id of made.classes) await sql(`DELETE FROM classes WHERE id = $1`, [id]);
  for (const id of made.intakes) await sql(`DELETE FROM intakes WHERE id = $1`, [id]);
  for (const id of made.tenants) await sql(`DELETE FROM tenants WHERE id = $1`, [id]);
});

afterAll(async () => { await pool.end(); });

// ─────────────────────────────────────────────────────────────────────────────
describe("attempt lifecycle — identity (L11, L16-L18, L22b, L26, L27, L28)", () => {
  it("L11: first attempt, no predecessor → attempt_seq 1, active row", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const row = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    expect(row.attempt_seq).toBe(1);
    expect(row.status).toBe("awaiting_payment");
    expect(row.integration_flow).toBe("direct_payment_intent");
  });

  it("L16: attempt 2 with no predecessor → ST001, nothing inserted, attempt 1 still active", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    await finalizeFails({ enrollmentId: e, tenantId: t, attempt: 2 }, "ST001");
    const rows = await paymentsFor(e);
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt_seq).toBe(1);
    expect(rows[0].status).toBe("awaiting_payment");
  });

  it("L17: attempt 1 when a later attempt exists → ST001", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    await finalize({ enrollmentId: e, tenantId: t, attempt: 2, predecessorId: a1.id as string });
    await finalizeFails({ enrollmentId: e, tenantId: t, attempt: 1 }, "ST001");
  });

  it("L18: attempt 1 retried when only attempt 1 exists → idempotent resolve, not ST001", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const intentId = `pi_${uniq()}`;
    const first = await finalize({ enrollmentId: e, tenantId: t, attempt: 1, intentId });
    const second = await finalize({ enrollmentId: e, tenantId: t, attempt: 1, intentId });
    expect(second.id).toBe(first.id);
    expect(await paymentsFor(e)).toHaveLength(1);
  });

  it("L22b: fractional p_amount → ST001, nothing inserted (RPC backstop)", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await finalizeFails({ enrollmentId: e, tenantId: t, attempt: 1, amount: 12.34, minor: 1234 }, "ST001");
    expect(await paymentsFor(e)).toHaveLength(0);
  });

  it("L26: p_amount_minor <> p_amount * 100 → ST001, nothing inserted", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await finalizeFails({ enrollmentId: e, tenantId: t, attempt: 1, amount: 12, minor: 999 }, "ST001");
    expect(await paymentsFor(e)).toHaveLength(0);
  });

  it("L27: currency outside the launch allow-list → ST001, nothing inserted", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await finalizeFails({ enrollmentId: e, tenantId: t, attempt: 1, currency: "jpy", amount: 5000, minor: 500000 }, "ST001");
    expect(await paymentsFor(e)).toHaveLength(0);
  });

  it("L28: uppercase 'SGD' → accepted, persists canonical 'sgd', identical retry resolves", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const intentId = `pi_${uniq()}`;
    const row = await finalize({ enrollmentId: e, tenantId: t, attempt: 1, intentId, currency: "SGD" });
    expect(row.provider_currency).toBe("sgd");
    // Retry with the same uppercase input must resolve, not raise a false mismatch.
    const retry = await finalize({ enrollmentId: e, tenantId: t, attempt: 1, intentId, currency: "SGD" });
    expect(retry.id).toBe(row.id);
  });
});

describe("attempt lifecycle — predecessor contract (L12-L15, L19, L19b, L20)", () => {
  it("L12: cross-tenant predecessor → ST001, the other tenant's payment untouched", async () => {
    const tA = await createTenant();
    const tB = await createTenant();
    const eA = await createEnrollment(tA);
    const eB = await createEnrollment(tB);
    const otherPred = await finalize({ enrollmentId: eB, tenantId: tB, attempt: 1 });
    await finalizeFails(
      { enrollmentId: eA, tenantId: tA, attempt: 2, predecessorId: otherPred.id as string },
      "ST001",
    );
    const [other] = await sql(`SELECT status FROM payments WHERE id = $1`, [otherPred.id]);
    expect(other.status).toBe("awaiting_payment");
  });

  it("L13: predecessor with the wrong attempt_seq → ST001, not silently skipped", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    // Claim attempt 3 with attempt-1 predecessor (should be exactly attempt 2's pred)
    await finalizeFails(
      { enrollmentId: e, tenantId: t, attempt: 3, predecessorId: a1.id as string },
      "ST001",
    );
  });

  it("L14: predecessor that is not a Stripe row → ST001", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const [bank] = await sql<{ id: string }>(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status)
       VALUES ($1, $2, 100, 'bank_transfer', 'pending') RETURNING id`,
      [e, t],
    );
    await finalizeFails(
      { enrollmentId: e, tenantId: t, attempt: 2, predecessorId: bank.id },
      "ST001",
    );
  });

  it("L15: resolved winner with a different amount → ST003", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const intentId = `pi_${uniq()}`;
    await finalize({ enrollmentId: e, tenantId: t, attempt: 1, intentId, amount: 100 });
    // Same attempt, different contract: resolves the winner, contract mismatch.
    await finalizeFails(
      { enrollmentId: e, tenantId: t, attempt: 1, intentId, amount: 200 },
      "ST003",
    );
  });

  it("L19: rejected predecessor, no other active row → identity anchor, no raise, nothing re-rejected", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    await sql(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [a1.id]);
    const a2 = await finalize({ enrollmentId: e, tenantId: t, attempt: 2, predecessorId: a1.id as string });
    expect(a2.attempt_seq).toBe(2);
    const rows = await paymentsFor(e);
    expect(rows.map((r) => [r.attempt_seq, r.status])).toEqual([
      [1, "rejected"],
      [2, "awaiting_payment"],
    ]);
  });

  it("L19b: rejected predecessor while an OLDER row is still active → ST001", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    const a2 = await finalize({ enrollmentId: e, tenantId: t, attempt: 2, predecessorId: a1.id as string });
    // Resurrect attempt 1 (historical anomaly) and reject attempt 2:
    await sql(`UPDATE payments SET status = 'awaiting_payment' WHERE id = $1`, [a1.id]);
    await sql(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [a2.id]);
    await finalizeFails(
      { enrollmentId: e, tenantId: t, attempt: 3, predecessorId: a2.id as string },
      "ST001",
    );
    expect(await paymentsFor(e)).toHaveLength(2); // attempt 3 was never inserted
  });

  it("L20: verified predecessor → ST002, no replacement recorded", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    await sql(`UPDATE payments SET status = 'verified' WHERE id = $1`, [a1.id]);
    await finalizeFails(
      { enrollmentId: e, tenantId: t, attempt: 2, predecessorId: a1.id as string },
      "ST002",
    );
    expect(await paymentsFor(e)).toHaveLength(1);
  });
});

describe("attempt lifecycle — provider-object ownership (L5/L21, L25)", () => {
  it("L5/L21: provider id owned by another enrollment → ST004 naming the owner", async () => {
    const t = await createTenant();
    const eOwner = await createEnrollment(t);
    const eThief = await createEnrollment(t);
    const intentId = `pi_${uniq()}`;
    const owner = await finalize({ enrollmentId: eOwner, tenantId: t, attempt: 1, intentId });
    const err = await finalizeFails(
      { enrollmentId: eThief, tenantId: t, attempt: 1, intentId },
      "ST004",
    );
    expect(err.message).toContain(String(owner.id));
    expect(await paymentsFor(eThief)).toHaveLength(0);
  });

  it("L25: unique violation from a NON-provider constraint → re-raised as-is, never ST004", async () => {
    const t = await createTenant();
    const e1 = await createEnrollment(t);
    const e2 = await createEnrollment(t);
    // Synthetic non-provider unique constraint the finalizer knows nothing about.
    const marker = 777001; // obscure amount so existing rows cannot collide
    await sql(`CREATE UNIQUE INDEX l25_tmp_uniq ON payments (tenant_id, amount) WHERE attempt_seq IS NOT NULL`);
    try {
      await finalize({ enrollmentId: e1, tenantId: t, attempt: 1, amount: marker, minor: marker * 100 });
      try {
        await finalize({ enrollmentId: e2, tenantId: t, attempt: 1, amount: marker, minor: marker * 100 });
        throw new Error("expected a unique violation");
      } catch (e) {
        const err = e as { code?: string };
        expect(err.code).toBe("23505"); // raw re-raise, NOT ST004
      }
    } finally {
      await sql(`DROP INDEX IF EXISTS l25_tmp_uniq`);
    }
  });
});

describe("attempt lifecycle — replacement and the Plan A shield (L2-L4, L6, L7, L10, L23, L24)", () => {
  it("L2/L3: crash-retry after provider creation → second call finalises, no duplicate row", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    const intentId = `pi_${uniq()}`;
    const call1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 2, intentId, predecessorId: a1.id as string });
    const call2 = await finalize({ enrollmentId: e, tenantId: t, attempt: 2, intentId, predecessorId: a1.id as string });
    expect(call2.id).toBe(call1.id);
    const rows = await paymentsFor(e);
    expect(rows.filter((r) => r.attempt_seq === 2)).toHaveLength(1);
  });

  it("L7: replacement retires the predecessor → shield is GONE, later failure releases the enrollment", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    const a2 = await finalize({ enrollmentId: e, tenantId: t, attempt: 2, predecessorId: a1.id as string });
    // Predecessor retired in the same transaction:
    const [p1] = await sql(`SELECT status FROM payments WHERE id = $1`, [a1.id]);
    expect(p1.status).toBe("rejected");
    // Enrollment untouched by the retirement (Plan A: replacement is active):
    const [enr1] = await sql(`SELECT status FROM enrollments WHERE id = $1`, [e]);
    expect(enr1.status).toBe("pending_payment");
    // The replacement later fails → Plan A's predicate finds no other active
    // payment, no verified payment → enrollment rejected. The shield is gone.
    await sql(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [a2.id]);
    const [enr2] = await sql(`SELECT status FROM enrollments WHERE id = $1`, [e]);
    expect(enr2.status).toBe("rejected");
  });

  it("L24: after a successful replacement, zero other active Stripe rows remain — by query", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    const a2 = await finalize({ enrollmentId: e, tenantId: t, attempt: 2, predecessorId: a1.id as string });
    const [active] = await sql(
      `SELECT count(*) n FROM payments
        WHERE enrollment_id = $1 AND payment_method = 'stripe'
          AND status IN ('awaiting_payment','pending') AND id <> $2`,
      [e, a2.id],
    );
    expect(Number(active.n)).toBe(0);
  });

  it("L23: a second active Stripe row exists → ST001, neither retired, nothing inserted", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    const a2 = await finalize({ enrollmentId: e, tenantId: t, attempt: 2, predecessorId: a1.id as string });
    // Historical anomaly: attempt 1 resurrected while attempt 2 is active.
    await sql(`UPDATE payments SET status = 'awaiting_payment' WHERE id = $1`, [a1.id]);
    await finalizeFails(
      { enrollmentId: e, tenantId: t, attempt: 3, predecessorId: a2.id as string },
      "ST001",
    );
    expect(await activeStripeCount(e)).toBe(2); // both untouched
    expect(await paymentsFor(e)).toHaveLength(2); // attempt 3 never inserted
  });

  it("L6: superseded row is NOT retired when the resolved replacement is not active", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    const intentId = `pi_${uniq()}`;
    const a2 = await finalize({ enrollmentId: e, tenantId: t, attempt: 2, intentId, predecessorId: a1.id as string });
    // a1 is now rejected (retired). Resurrect a1, then mark a2 verified and
    // retry the SAME finalize call: v_row resolves to a verified row, so the
    // retirement branch must not fire against a1 again.
    await sql(`UPDATE payments SET status = 'verified' WHERE id = $1`, [a2.id]);
    await sql(`UPDATE payments SET status = 'awaiting_payment' WHERE id = $1`, [a1.id]);
    // ST001 shield check sees a1 active + a2 not active-but-same-attempt →
    // a1 IS another active row distinct from attempt 3's identity, so a fresh
    // attempt fails closed (covered by L23). The retry of ATTEMPT 2 itself:
    const retry = await finalize({ enrollmentId: e, tenantId: t, attempt: 2, intentId, predecessorId: a1.id as string });
    expect(retry.status).toBe("verified"); // resolved, not re-inserted
    const [p1] = await sql(`SELECT status FROM payments WHERE id = $1`, [a1.id]);
    expect(p1.status).toBe("awaiting_payment"); // NOT retired: replacement not active
  });

  it("L1/L4/L10: concurrent finalisation of the same attempt converges on ONE row", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    const a1 = await finalize({ enrollmentId: e, tenantId: t, attempt: 1 });
    const intentId = `pi_${uniq()}`;
    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      const a = args({ enrollmentId: e, tenantId: t, attempt: 2, intentId, predecessorId: a1.id as string });
      const [r1, r2] = await Promise.allSettled([c1.query(FINALIZE, a), c2.query(FINALIZE, a)]);
      // Both must succeed (converge), or one may serialize behind the other's
      // lock and still resolve — but NEITHER may error, and both must name
      // the same row.
      expect(r1.status, JSON.stringify(r1)).toBe("fulfilled");
      expect(r2.status, JSON.stringify(r2)).toBe("fulfilled");
      const id1 = (r1 as PromiseFulfilledResult<{ rows: { id: string }[] }>).value.rows[0].id;
      const id2 = (r2 as PromiseFulfilledResult<{ rows: { id: string }[] }>).value.rows[0].id;
      expect(id1).toBe(id2);
      const rows = await paymentsFor(e);
      expect(rows.filter((r) => r.attempt_seq === 2)).toHaveLength(1);
    } finally {
      await c1.end();
      await c2.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("migration contract (M4, M5) — live schema", () => {
  const insertFails = async (text: string, params: unknown[], constraint: string) => {
    try {
      await pool.query(text, params);
      throw new Error(`expected violation of ${constraint}`);
    } catch (e) {
      const err = e as { code?: string; constraint?: string; message?: string };
      expect(err.code, err.message).toMatch(/23514|23502/);
      expect(err.constraint).toBe(constraint);
    }
  };

  it("M4: Stripe row with a null attempt is rejected (bidirectional)", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await insertFails(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, stripe_payment_intent_id)
       VALUES ($1, $2, 100, 'stripe', 'pending', $3)`,
      [e, t, `pi_${uniq()}`],
      "payments_attempt_is_stripe_chk",
    );
  });

  it("M4: non-Stripe row with an attempt is rejected", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await insertFails(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, attempt_seq, integration_flow)
       VALUES ($1, $2, 100, 'bank_transfer', 'pending', 1, 'direct_payment_intent')`,
      [e, t],
      "payments_attempt_is_stripe_chk",
    );
  });

  it("M4: null-payment_method row with an attempt is rejected (coalesce totality)", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await insertFails(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, status, attempt_seq, integration_flow)
       VALUES ($1, $2, 100, 'pending', 1, 'direct_payment_intent')`,
      [e, t],
      "payments_attempt_is_stripe_chk",
    );
  });

  it("M4: direct row with no intent id is rejected", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await insertFails(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, attempt_seq, integration_flow)
       VALUES ($1, $2, 100, 'stripe', 'pending', 1, 'direct_payment_intent')`,
      [e, t],
      "payments_flow_ids_chk",
    );
  });

  it("M4: hosted row with no session id is rejected", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await insertFails(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, attempt_seq, integration_flow, stripe_payment_intent_id)
       VALUES ($1, $2, 100, 'stripe', 'pending', 1, 'hosted_checkout', $3)`,
      [e, t, `pi_${uniq()}`],
      "payments_flow_ids_chk",
    );
  });

  it("M4: attempt without a flow is rejected", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await insertFails(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, attempt_seq, stripe_payment_intent_id)
       VALUES ($1, $2, 100, 'stripe', 'pending', 1, $3)`,
      [e, t, `pi_${uniq()}`],
      "payments_attempt_flow_chk",
    );
  });

  it("M4: non-Stripe row carrying a provider id is rejected", async () => {
    const t = await createTenant();
    const e = await createEnrollment(t);
    await insertFails(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, stripe_session_id)
       VALUES ($1, $2, 100, 'bank_transfer', 'pending', $3)`,
      [e, t, `cs_${uniq()}`],
      "payments_provider_ids_are_stripe_chk",
    );
  });

  it("M5: anon and authenticated cannot execute the finalizer; service_role can", async () => {
    // Resolved by NAME, not by a written-out argument list. The signature was
    // spelled out here and in the migration gate, and both went stale the day a
    // parameter was added (20260903090000), reporting "does not exist" for a
    // function that was present and locked down. Requiring exactly one match is
    // also the stronger assertion: a DROP that misses leaves an old overload
    // behind, still carrying the PUBLIC execute grant this test exists to deny.
    const rows = await sql<{ anon: boolean; auth: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon'::name, p.oid, 'execute') AS anon,
              has_function_privilege('authenticated'::name, p.oid, 'execute') AS auth,
              has_function_privilege('service_role'::name, p.oid, 'execute') AS service
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'finalize_stripe_payment_attempt'`,
      [],
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.anon).toBe(false);
    expect(row.auth).toBe(false);
    expect(row.service).toBe(true);
  });

  it("conflicts table: resolved + pending is CHECK-rejected", async () => {
    try {
      await pool.query(
        `INSERT INTO payment_settlement_conflicts
           (provider, provider_object_id, first_source_type, first_source_id,
            last_source_type, last_source_id, conflict_type, status, cleanup_status, resolved_at)
         VALUES ('stripe', $1, 'creation_request', 'req_x', 'creation_request', 'req_x',
                 'provider_object_owned', 'resolved', 'pending', now())`,
        [`pi_${uniq()}`],
      );
      throw new Error("expected pscf_cleanup_resolved_chk violation");
    } catch (e) {
      expect((e as { constraint?: string }).constraint).toBe("pscf_cleanup_resolved_chk");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M1-M3, M6, M7: replay the SHIPPED migration file against synthetic
// pre-migration state, entirely inside a rolled-back transaction.
describe("migration replay (M1-M3, M6, M7) — the shipped artifact", () => {
  const migrationSql = () =>
    fs
      .readFileSync(MIGRATION, "utf8")
      .replace(/^\s*BEGIN;\s*$/m, "")
      .replace(/^\s*COMMIT;\s*$/m, "");

  /** Reverse the migration inside the open transaction of `c`. */
  async function reverse(c: Client) {
    // Every overload, by name. Spelling the argument list out here made
    // "reverse the migration" mean "reverse the migration AS IT WAS SHIPPED",
    // so all six replay cases broke the day a parameter was added
    // (20260903090000) — the live function was no longer the one named.
    await c.query(`DO $drop$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT oid::regprocedure AS sig FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace
                    AND proname = 'finalize_stripe_payment_attempt'
        LOOP EXECUTE 'DROP FUNCTION ' || r.sig; END LOOP;
      END $drop$`);
    await c.query(`DROP TABLE public.payment_settlement_conflicts`);
    await c.query(`DROP INDEX payments_stripe_payment_intent_id_uniq`);
    await c.query(`DROP INDEX payments_stripe_session_id_uniq`);
    await c.query(`DROP INDEX payments_enrollment_attempt_uniq`);
    for (const con of [
      "payments_attempt_seq_chk", "payments_integration_flow_chk", "payments_attempt_flow_chk",
      "payments_attempt_is_stripe_chk", "payments_provider_ids_are_stripe_chk", "payments_flow_ids_chk",
    ]) {
      await c.query(`ALTER TABLE payments DROP CONSTRAINT ${con}`);
    }
    await c.query(`ALTER TABLE payments
      DROP COLUMN provider_amount_minor, DROP COLUMN provider_currency,
      DROP COLUMN integration_flow, DROP COLUMN attempt_seq`);
    // Restore the pre-migration plain index the migration drops:
    await c.query(`CREATE INDEX payments_stripe_payment_intent_id_idx ON payments (stripe_payment_intent_id)`);
  }

  async function withReplayTxn(fn: (c: Client) => Promise<void>) {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      await reverse(c);
      await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
  }

  async function seedEnrollment(c: Client): Promise<{ tenantId: string; enrollmentId: string }> {
    const slug = uniq();
    const t = (await c.query(
      `INSERT INTO tenants (name, subdomain) VALUES ($1, $2) RETURNING id`,
      [`Replay ${slug}`, slug],
    )).rows[0].id;
    const i = (await c.query(
      `INSERT INTO intakes (tenant_id, name, year) VALUES ($1, 'Replay', 2026) RETURNING id`,
      [t],
    )).rows[0].id;
    const cl = (await c.query(
      `INSERT INTO classes (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining, status)
       VALUES ($1, $2, $3, 100, 10, 7, 'open') RETURNING id`,
      [t, i, `L${uniq()}`],
    )).rows[0].id;
    const e = (await c.query(
      `INSERT INTO enrollments (enrollment_ref, tenant_id, student_name_en, phone, class_id, quantity, status)
       VALUES ('', $1, 'Replay Student', '09000000000', $2, 1, 'pending_payment') RETURNING id`,
      [t, cl],
    )).rows[0].id;
    return { tenantId: t, enrollmentId: e };
  }

  it("M1: historical row carrying BOTH provider ids backfills hosted_checkout, never direct", async () => {
    await withReplayTxn(async (c) => {
      const { tenantId, enrollmentId } = await seedEnrollment(c);
      const pi = `pi_${uniq()}`;
      const cs = `cs_${uniq()}`;
      await c.query(
        `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status,
                               stripe_session_id, stripe_payment_intent_id)
         VALUES ($1, $2, 100, 'stripe', 'verified', $3, $4)`,
        [enrollmentId, tenantId, cs, pi],
      );
      await c.query(migrationSql());
      const { rows } = await c.query(
        `SELECT integration_flow, attempt_seq FROM payments WHERE stripe_session_id = $1`, [cs],
      );
      expect(rows[0].integration_flow).toBe("hosted_checkout");
      expect(rows[0].attempt_seq).toBe(1);
    });
  });

  it("M2: row with only an intent id backfills direct_payment_intent", async () => {
    await withReplayTxn(async (c) => {
      const { tenantId, enrollmentId } = await seedEnrollment(c);
      const pi = `pi_${uniq()}`;
      await c.query(
        `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, stripe_payment_intent_id)
         VALUES ($1, $2, 100, 'stripe', 'verified', $3)`,
        [enrollmentId, tenantId, pi],
      );
      await c.query(migrationSql());
      const { rows } = await c.query(
        `SELECT integration_flow FROM payments WHERE stripe_payment_intent_id = $1`, [pi],
      );
      expect(rows[0].integration_flow).toBe("direct_payment_intent");
    });
  });

  it("M3: multi-payment enrollment numbers attempts 1..n by creation order; unique index holds", async () => {
    await withReplayTxn(async (c) => {
      const { tenantId, enrollmentId } = await seedEnrollment(c);
      const ids: string[] = [];
      for (let k = 0; k < 3; k++) {
        const { rows } = await c.query(
          `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status,
                                 stripe_payment_intent_id, created_at)
           VALUES ($1, $2, 100, 'stripe', 'rejected', $3, now() + ($4 || ' seconds')::interval)
           RETURNING id`,
          [enrollmentId, tenantId, `pi_${uniq()}`, String(k)],
        );
        ids.push(rows[0].id);
      }
      await c.query(migrationSql());
      const { rows } = await c.query(
        `SELECT id, attempt_seq FROM payments WHERE enrollment_id = $1 ORDER BY attempt_seq`,
        [enrollmentId],
      );
      expect(rows.map((r) => r.attempt_seq)).toEqual([1, 2, 3]);
      expect(rows.map((r) => r.id)).toEqual(ids); // creation order
    });
  });

  it("M6a: wrong-typed attempt_seq stops the migration loudly (before the assertion)", async () => {
    await withReplayTxn(async (c) => {
      // ADD COLUMN IF NOT EXISTS silently accepts this. The attempt_seq CHECK
      // (`> 0`) cannot compare text to integer, so the migration dies there —
      // earlier than the shape assertion, but still a hard stop, which is the
      // property that matters.
      await c.query(`ALTER TABLE payments ADD COLUMN attempt_seq text`);
      try {
        await c.query(migrationSql());
        throw new Error("expected the migration to fail");
      } catch (e) {
        expect((e as { message?: string }).message).toMatch(
          /operator does not exist|contract columns are not the expected shape/i,
        );
      }
    });
  });

  it("M6b: wrong-typed column nothing else touches is caught by the shape assertion itself", async () => {
    await withReplayTxn(async (c) => {
      // provider_amount_minor is not referenced by any constraint or the
      // backfill, so a wrong type survives every earlier statement — the
      // shape assertion is the ONLY thing standing between it and production.
      await c.query(`ALTER TABLE payments ADD COLUMN provider_amount_minor integer`);
      try {
        await c.query(migrationSql());
        throw new Error("expected the shape assertion to fail");
      } catch (e) {
        expect((e as { message?: string }).message).toMatch(
          /contract columns are not the expected shape/i,
        );
      }
    });
  });

  it("M7: a stripe row with NO provider id aborts the migration (audit B exists to find these first)", async () => {
    await withReplayTxn(async (c) => {
      const { tenantId, enrollmentId } = await seedEnrollment(c);
      await c.query(
        `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status)
         VALUES ($1, $2, 100, 'stripe', 'pending')`,
        [enrollmentId, tenantId],
      );
      try {
        await c.query(migrationSql());
        throw new Error("expected the bidirectional constraint to abort the migration");
      } catch (e) {
        const err = e as { code?: string; constraint?: string };
        expect(err.code).toBe("23514");
        expect(err.constraint).toBe("payments_attempt_is_stripe_chk");
      }
    });
  });
});
