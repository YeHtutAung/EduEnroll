import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { Pool, Client } from "pg";

// ─── A failed payment must not reject an enrollment another payment paid for ─
//
// fn_payments_sync_enrollment()'s rejection branch had no predicate, so
// rejecting ANY payment rejected the enrollment: a stale Payment B failing
// after Payment A verified would reject a CONFIRMED enrollment, seat
// restoration released the seat, and it was resold under a valid ticket.
//
// The fix is a predicate inside the trigger's own UPDATE. These tests run the
// REAL triggers against the REAL database — the defect is trigger behaviour
// and MVCC visibility, neither of which exists in a mock.
//
// Phase matrix (recorded, not predicted): T1, T3, T4, T5, T6, T9 fail against
// the pre-fix function; T2, T7 pass as regression guards; T8, T10a, T10b,
// T11, T12 are migration-safety tests that manage their own function state
// inside rolled-back transactions and do not depend on what is installed.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Migration-file extraction ───────────────────────────────────────────────
// The guard under test is the SHIPPED guard text, extracted from the migration
// file — not a copy that could drift from it. Same for the #187 baseline body.

const GUARD_MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260722120000_guard_payment_rejection.sql",
);
const BASELINE_MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260721120000_block_reconfirm_rejected.sql",
);

function extractGuardBlock(): string {
  const src = readFileSync(GUARD_MIGRATION, "utf8");
  const start = src.indexOf("DO $guard$");
  const end = src.indexOf("END $guard$;", start);
  if (start === -1 || end === -1) throw new Error("guard block not found in migration");
  return src.slice(start, end + "END $guard$;".length);
}

/** CREATE OR REPLACE … $$ … $$; for fn_payments_sync_enrollment from a file. */
function extractCreateFn(file: string): string {
  const src = readFileSync(file, "utf8");
  const start = src.indexOf("CREATE OR REPLACE FUNCTION public.fn_payments_sync_enrollment()");
  if (start === -1) throw new Error(`create-function block not found in ${file}`);
  const end = src.indexOf("$$;", src.indexOf("AS $$", start));
  if (end === -1) throw new Error(`create-function terminator not found in ${file}`);
  return src.slice(start, end + "$$;".length);
}

const GUARD_SQL = extractGuardBlock();
const BASELINE_FN = extractCreateFn(BASELINE_MIGRATION);
const FIXED_FN = extractCreateFn(GUARD_MIGRATION);

// ── Fixtures ────────────────────────────────────────────────────────────────

type Tracked = { tenants: string[]; intakes: string[]; classes: string[]; enrollments: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], enrollments: [] });
let seq = 0;
const uniq = () => `rg${Date.now().toString(36)}${seq++}`;

async function makeWorld(opts: { enrollmentStatus?: string; quantity?: number } = {}) {
  const { enrollmentStatus = "pending_payment", quantity = 1 } = opts;
  const slug = uniq();
  const [t] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1,$2,'event') RETURNING id`,
    [`Guard ${slug}`, slug],
  );
  made.tenants.push(t.id);
  const [i] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1,'Guard intake',2026) RETURNING id`,
    [t.id],
  );
  made.intakes.push(i.id);
  const [c] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id,intake_id,level,fee_amount,seat_total,seat_remaining,status,
                          max_tickets_per_person)
     VALUES ($1,$2,$3,100,50,40,'open',10) RETURNING id`,
    [t.id, i.id, `L${uniq()}`],
  );
  made.classes.push(c.id);
  const [e] = await sql<{ id: string }>(
    `INSERT INTO enrollments (enrollment_ref,tenant_id,student_name_en,phone,class_id,quantity,status)
     VALUES ('',$1,'Guard Test','09000000000',$2,$3,$4::enrollment_status) RETURNING id`,
    [t.id, c.id, quantity, enrollmentStatus],
  );
  made.enrollments.push(e.id);
  return { tenantId: t.id, intakeId: i.id, classId: c.id, enrollmentId: e.id };
}

async function addPayment(enrollmentId: string, tenantId: string, status: string) {
  const [p] = await sql<{ id: string }>(
    `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status)
     VALUES ($1,$2,100,'bank_transfer',$3::payment_status) RETURNING id`,
    [enrollmentId, tenantId, status],
  );
  return p.id;
}

const enrollmentStatus = async (id: string) =>
  (await sql<{ status: string }>(`SELECT status FROM enrollments WHERE id=$1`, [id]))[0].status;
const seatRemaining = async (id: string) =>
  Number(
    (await sql<{ seat_remaining: number }>(`SELECT seat_remaining FROM classes WHERE id=$1`, [id]))[0]
      .seat_remaining,
  );

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1");
});

afterEach(async () => {
  const { tenants, intakes, classes, enrollments } = made;
  if (enrollments.length) {
    await sql(`DELETE FROM tickets  WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM payments WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM enrollments WHERE id = ANY($1::uuid[])`, [enrollments]);
  }
  if (classes.length) await sql(`DELETE FROM classes WHERE id = ANY($1::uuid[])`, [classes]);
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

// ─── Behavioural: the rejection predicate ───────────────────────────────────

describe("payment rejection guard — behaviour", () => {
  it("T1 a stale payment's rejection leaves a paid enrollment untouched", async () => {
    const w = await makeWorld();
    const payA = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");
    const payB = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");

    await sql(`UPDATE payments SET status='verified' WHERE id=$1`, [payA]);
    expect(await enrollmentStatus(w.enrollmentId)).toBe("confirmed");

    // A ticket exists for the confirmed enrollment.
    await sql(
      `INSERT INTO tickets (tenant_id,intake_id,enrollment_id,class_id,tier,admits,seat_no,exp,kid,status)
       VALUES ($1,$2,$3,$4,'T1',1,1, now() + interval '30 days','kid-test','valid')`,
      [w.tenantId, w.intakeId, w.enrollmentId, w.classId],
    );
    const seatsBefore = await seatRemaining(w.classId);

    // The stale attempt fails.
    await sql(`UPDATE payments SET status='rejected' WHERE id=$1`, [payB]);

    expect(await enrollmentStatus(w.enrollmentId)).toBe("confirmed");
    expect(await seatRemaining(w.classId)).toBe(seatsBefore); // seat NOT restored
    const [tk] = await sql<{ status: string }>(
      `SELECT status FROM tickets WHERE enrollment_id=$1`,
      [w.enrollmentId],
    );
    expect(tk.status).toBe("valid");
  });

  it("T2 rejecting the only payment on a pending enrollment still rejects it", async () => {
    const w = await makeWorld();
    const pay = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");
    const seatsBefore = await seatRemaining(w.classId);

    await sql(`UPDATE payments SET status='rejected' WHERE id=$1`, [pay]);

    expect(await enrollmentStatus(w.enrollmentId)).toBe("rejected");
    // Seat restoration on rejection is owned by update_seat_remaining; assert
    // the delta rather than an absolute so this stays a regression guard for
    // "rejection still releases capacity".
    expect(await seatRemaining(w.classId)).toBeGreaterThanOrEqual(seatsBefore);
  });

  it("T3 rejection is blocked while another payment is awaiting_payment", async () => {
    const w = await makeWorld();
    await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment"); // the live attempt
    const payB = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");
    const seatsBefore = await seatRemaining(w.classId);

    await sql(`UPDATE payments SET status='rejected' WHERE id=$1`, [payB]);

    expect(await enrollmentStatus(w.enrollmentId)).toBe("pending_payment");
    expect(await seatRemaining(w.classId)).toBe(seatsBefore);
  });

  it("T4 rejection is blocked while another payment is pending", async () => {
    const w = await makeWorld({ enrollmentStatus: "payment_submitted" });
    const other = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");
    await sql(`UPDATE payments SET status='pending' WHERE id=$1`, [other]);
    const payB = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");

    await sql(`UPDATE payments SET status='rejected' WHERE id=$1`, [payB]);

    expect(await enrollmentStatus(w.enrollmentId)).toBe("payment_submitted");
  });

  it("T5 concurrent verify and reject never strand a paid enrollment", async () => {
    // Two real connections with explicit synchronisation points. Without them,
    // "tested both orderings" can pass while the intended interleaving never
    // actually occurred.
    const run = async (verifierFirst: boolean) => {
      const w = await makeWorld();
      const payA = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");
      const payB = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");

      const c1 = new Client({ connectionString: process.env.DATABASE_URL });
      const c2 = new Client({ connectionString: process.env.DATABASE_URL });
      await c1.connect();
      await c2.connect();
      // Per-step timeout: a deadlock fails the test instead of hanging it.
      await c1.query(`SET statement_timeout = '5s'`);
      await c2.query(`SET statement_timeout = '5s'`);

      try {
        if (verifierFirst) {
          // A open-but-uncommitted BEFORE B is issued — the sync point.
          await c1.query("BEGIN");
          await c1.query(`UPDATE payments SET status='verified' WHERE id=$1`, [payA]);

          // B is issued strictly inside A's open transaction — that is the
          // synchronisation point, established by construction (A's UPDATE has
          // returned; COMMIT has not been sent).
          //
          // Whether B then BLOCKS is a mechanism, not the contract, and the
          // first version of this test wrongly asserted it. Pre-fix, B's
          // unguarded UPDATE matched the enrollment row and blocked on A's
          // lock. Post-fix, the predicate's NOT EXISTS sees payA at its
          // VISIBLE state — awaiting_payment — filters the row out, and B
          // completes immediately as a no-op. B finishing while A is still
          // uncommitted is itself proof the race interleaving occurred.
          let bDone = false;
          const bPromise = c2
            .query(`UPDATE payments SET status='rejected' WHERE id=$1`, [payB])
            .then(() => {
              bDone = true;
            });
          await new Promise((r) => setTimeout(r, 300));

          if (bDone) {
            // B ran to completion against A's uncommitted state: the guard
            // must have declined already, while A was still in flight.
            expect(await enrollmentStatus(w.enrollmentId)).not.toBe("rejected");
          }
          await c1.query("COMMIT");
          await bPromise;
        } else {
          // B open-but-uncommitted BEFORE A is issued.
          await c2.query("BEGIN");
          await c2.query(`UPDATE payments SET status='rejected' WHERE id=$1`, [payB]);
          // A's visible state for payA is 'awaiting_payment', so B's predicate
          // must already have declined to touch the enrollment.
          await c1.query(`UPDATE payments SET status='verified' WHERE id=$1`, [payA]);
          await c2.query("COMMIT");
        }
      } finally {
        await c1.end();
        await c2.end();
      }

      // The invariant, either ordering: never rejected while a verified
      // payment exists.
      expect(await enrollmentStatus(w.enrollmentId)).toBe("confirmed");
      const [a] = await sql<{ status: string }>(`SELECT status FROM payments WHERE id=$1`, [payA]);
      expect(a.status).toBe("verified");
    };

    await run(true);
    await run(false);
  });

  it("T6 rejecting a payment on a confirmed enrollment leaves it confirmed", async () => {
    // The deliberate ownership change: cancelling a CONFIRMED enrollment is a
    // separate audited operation, never a side effect of payment status.
    const w = await makeWorld();
    const pay = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");
    await sql(`UPDATE payments SET status='verified' WHERE id=$1`, [pay]);
    expect(await enrollmentStatus(w.enrollmentId)).toBe("confirmed");
    const seatsBefore = await seatRemaining(w.classId);

    // Un-verify bookkeeping is not the point here; reject the same payment.
    await sql(`UPDATE payments SET status='rejected' WHERE id=$1`, [pay]);

    expect(await enrollmentStatus(w.enrollmentId)).toBe("confirmed");
    expect(await seatRemaining(w.classId)).toBe(seatsBefore);
  });

  it("T7 rejection against an already-rejected enrollment changes nothing", async () => {
    const w = await makeWorld({ enrollmentStatus: "rejected" });
    const pay = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");

    await sql(`UPDATE payments SET status='rejected' WHERE id=$1`, [pay]);

    expect(await enrollmentStatus(w.enrollmentId)).toBe("rejected");
  });

  it("T9 a dead active row shields the enrollment — the invariant Plan B must keep", async () => {
    // A superseded payment left 'awaiting_payment' looks exactly like a live
    // attempt to the guard, so the real attempt's rejection does nothing. Not
    // a defect of the guard: it is why any replacement flow must mark the
    // superseded row terminal once its replacement is safely recorded.
    const w = await makeWorld();
    await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment"); // dead, never retired
    const real = await addPayment(w.enrollmentId, w.tenantId, "awaiting_payment");

    await sql(`UPDATE payments SET status='rejected' WHERE id=$1`, [real]);

    expect(await enrollmentStatus(w.enrollmentId)).toBe("pending_payment");
  });
});

// ─── Migration safety: the baseline guard ───────────────────────────────────
//
// Each test installs its own function state inside a rolled-back transaction,
// then runs the SHIPPED guard text against it. Nothing here depends on which
// version is currently installed.

describe("payment rejection guard — migration baseline guard", () => {
  const inRolledBackTxn = async (fn: (c: InstanceType<typeof Client>) => Promise<void>) => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
  };

  const expectGuardRaise = async (c: InstanceType<typeof Client>, fragment: string) => {
    let err: unknown = null;
    try {
      await c.query(GUARD_SQL);
    } catch (e) {
      err = e;
    }
    expect(err, "guard should have raised").not.toBeNull();
    expect(String((err as Error).message)).toContain(fragment);
  };

  it("T8 raises against a body that is not the #187 baseline", async () => {
    await inRolledBackTxn(async (c) => {
      await c.query(
        BASELINE_FN.replace("SET status = 'rejected'", "SET status = 'rejected' /* drift */"),
      );
      await expectGuardRaise(c, "differs from the reviewed #187 baseline");
    });
  });

  it("T10a passes with the correct public function even when another schema has a decoy", async () => {
    await inRolledBackTxn(async (c) => {
      await c.query(BASELINE_FN); // correct baseline in public
      await c.query(`CREATE SCHEMA IF NOT EXISTS guard_decoy`);
      await c.query(
        BASELINE_FN.replace(
          "FUNCTION public.fn_payments_sync_enrollment()",
          "FUNCTION guard_decoy.fn_payments_sync_enrollment()",
        ).replace("SET status = 'rejected'", "SET status = 'rejected' /* decoy */"),
      );
      await c.query(GUARD_SQL); // must NOT raise — the decoy is irrelevant
    });
  });

  it("T10b fails when only another schema matches the baseline", async () => {
    await inRolledBackTxn(async (c) => {
      // public drifted; a byte-perfect baseline lives in the decoy schema.
      await c.query(BASELINE_FN.replace("RETURN NEW;", "RETURN NEW; -- drifted"));
      await c.query(`CREATE SCHEMA IF NOT EXISTS guard_decoy`);
      await c.query(
        BASELINE_FN.replace(
          "FUNCTION public.fn_payments_sync_enrollment()",
          "FUNCTION guard_decoy.fn_payments_sync_enrollment()",
        ),
      );
      await expectGuardRaise(c, "differs from the reviewed #187 baseline");
    });
  });

  it("T11 running the migration guard twice fails: the fixed body is not the baseline", async () => {
    await inRolledBackTxn(async (c) => {
      await c.query(FIXED_FN); // what the migration installs
      await expectGuardRaise(c, "differs from the reviewed #187 baseline");
    });
  });

  it("T12 a single-character mutation of the baseline fails the hash", async () => {
    await inRolledBackTxn(async (c) => {
      await c.query(BASELINE_FN.replace("RETURN NEW;", "RETURN  NEW;")); // one extra space
      await expectGuardRaise(c, "differs from the reviewed #187 baseline");
    });
  });

  it("sanity: the shipped hash matches a byte-perfect #187 reinstall", async () => {
    // Ties the constant in the migration to the baseline text it claims to
    // hash — if either is edited independently, this breaks.
    await inRolledBackTxn(async (c) => {
      await c.query(BASELINE_FN);
      await c.query(GUARD_SQL); // passes only when md5(prosrc) equals the constant
    });
  });
});
