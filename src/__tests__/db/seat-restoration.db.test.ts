import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";

// ─── Seat restoration: database integration tests ───────────────────────────
// Trigger interaction cannot be tested with mocks. The mocked suite can only
// assert which functions the application calls — it reported green while five
// separate writers double-restored, under-restored, or silently failed.
//
// Requires the isolated local stack. See setup.ts for the local-only guards.
//
// FIXTURE RULE: every class starts with headroom below seat_total. The
// restoration paths clamp with LEAST(seat_remaining + n, seat_total), so a
// class already at capacity hides an over-restoration entirely — measured:
// the same defect passes at 10/10 and fails at 5/10.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const admin = createClient(
  process.env.SUPABASE_TEST_URL!,
  process.env.SUPABASE_TEST_SERVICE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Fixture tracking ────────────────────────────────────────────────────────
// Ids are recorded at creation, never at teardown: a test that fails midway
// must still have recorded what it made. A leaked pending_payment enrollment
// would be swept up by the NEXT test's expiry call — check_expired_enrollments
// is global — producing a failure in an unrelated test.
type Tracked = {
  tenants: string[];
  intakes: string[];
  classes: string[];
  enrollments: string[];
  payments: string[];
  authUsers: string[];
};
let made: Tracked;

const fresh = (): Tracked => ({
  tenants: [], intakes: [], classes: [], enrollments: [], payments: [], authUsers: [],
});

let seq = 0;
const uniq = () => `t${Date.now().toString(36)}${seq++}`;

// ── Fixture builders ────────────────────────────────────────────────────────

async function createTenant(autoCancelMinutes = 0): Promise<string> {
  const slug = uniq();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, auto_cancel_hours)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Test ${slug}`, slug, autoCancelMinutes],
  );
  made.tenants.push(row.id);
  return row.id;
}

async function createIntake(tenantId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1, 'Test intake', 2026) RETURNING id`,
    [tenantId],
  );
  made.intakes.push(row.id);
  return row.id;
}

/** Always created with headroom: 7 remaining of 10 unless overridden. */
async function createClassRow(
  tenantId: string,
  intakeId: string,
  seatTotal = 10,
  seatRemaining = 7,
  status = "open",
): Promise<string> {
  // (intake_id, level) is UNIQUE, so a test needing two classes in one intake
  // must not reuse the level. Generated rather than passed in, so the
  // constraint cannot be tripped by a caller that forgets.
  const [row] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining, status)
     VALUES ($1, $2, $5, 100, $3, $4, $6::class_status) RETURNING id`,
    [tenantId, intakeId, seatTotal, seatRemaining, `L${uniq()}`, status],
  );
  made.classes.push(row.id);
  return row.id;
}

async function createEnrollment(opts: {
  tenantId: string;
  classId: string | null;
  quantity?: number;
  status?: string;
  minutesAgo?: number;
}): Promise<string> {
  const { tenantId, classId, quantity = 1, status = "pending_payment", minutesAgo = 0 } = opts;
  const [row] = await sql<{ id: string }>(
    `INSERT INTO enrollments
       (enrollment_ref, tenant_id, student_name_en, phone, class_id, quantity, status, enrolled_at)
     VALUES ('', $1, 'Test Student', '09000000000', $2, $3, $4::enrollment_status,
             now() - ($5 || ' minutes')::interval)
     RETURNING id`,
    [tenantId, classId, quantity, status, String(minutesAgo)],
  );
  made.enrollments.push(row.id);
  return row.id;
}

async function addItem(enrollmentId: string, classId: string, tenantId: string, quantity: number) {
  await sql(
    `INSERT INTO enrollment_items (enrollment_id, class_id, tenant_id, fee_amount, quantity)
     VALUES ($1, $2, $3, 100, $4)`,
    [enrollmentId, classId, tenantId, quantity],
  );
}

// payment_status is (awaiting_payment, pending, verified, rejected) — NOT the
// enrollment_status values. The payment trigger only cascades when the old
// status differs from 'rejected', so 'pending' is the state a real rejection
// starts from.
async function createPayment(enrollmentId: string, tenantId: string, status = "pending") {
  const [row] = await sql<Record<string, unknown>>(
    `INSERT INTO payments (enrollment_id, tenant_id, amount, status)
     VALUES ($1, $2, 100, $3::payment_status) RETURNING *`,
    [enrollmentId, tenantId, status],
  );
  made.payments.push(row.id as string);
  return row;
}

// ── Readers ─────────────────────────────────────────────────────────────────

const seats = async (classId: string) =>
  Number((await sql<{ seat_remaining: number }>(
    `SELECT seat_remaining FROM classes WHERE id = $1`, [classId],
  ))[0].seat_remaining);

const classStatus = async (classId: string) =>
  (await sql<{ status: string }>(`SELECT status FROM classes WHERE id = $1`, [classId]))[0].status;

const enrollmentRow = async (id: string) =>
  (await sql<Record<string, unknown>>(`SELECT * FROM enrollments WHERE id = $1`, [id]))[0];

const expireNow = async () =>
  (await sql<{ r: Record<string, unknown> }>(`SELECT public.check_expired_enrollments() AS r`))[0].r;

const setSeats = async (classId: string, total: number, remaining: number) =>
  sql(`UPDATE classes SET seat_total = $2, seat_remaining = $3 WHERE id = $1`,
      [classId, total, remaining]);

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1"); // fail fast on a bad DATABASE_URL
});

afterEach(async () => {
  // FK-safe order. Runs even when the test failed, hence the recorded ids.
  // BEGIN..ROLLBACK is unavailable: verifyPayment() goes through PostgREST on
  // a separate connection, which a SQL transaction cannot roll back.
  // Cleanup failures are NOT swallowed. A leaked pending_payment enrollment is
  // swept up by the next test's expiry call — check_expired_enrollments is
  // global — so a silent teardown failure surfaces as an unrelated test
  // failing, which is far harder to diagnose than a loud one here.
  const { tenants, intakes, classes, enrollments, payments, authUsers } = made;
  if (enrollments.length) {
    await sql(`DELETE FROM tickets WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM payments WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM enrollment_items WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM enrollments WHERE id = ANY($1::uuid[])`, [enrollments]);
  }
  if (payments.length) await sql(`DELETE FROM payments WHERE id = ANY($1::uuid[])`, [payments]);
  if (classes.length) await sql(`DELETE FROM classes WHERE id = ANY($1::uuid[])`, [classes]);
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);

  // deleteUser RESOLVES with { error } rather than rejecting, so a .catch()
  // would never see an API failure and local auth users would accumulate.
  for (const uid of authUsers) {
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) throw new Error(`Failed to delete auth user ${uid}: ${error.message}`);
  }
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

/**
 * tenant + intake + class with headroom, plus the ids needed to build on it.
 *
 * seat_total defaults to 100 against seat_remaining 7 — far more headroom than
 * any test restores. This is not arbitrary. Restoration clamps with
 * LEAST(seat_remaining + n, seat_total), and the CHECK constraint
 * (seat_remaining <= seat_total) rejects anything above it, so a class near
 * capacity absorbs an over-restoration and the defect vanishes:
 *
 *   seat_total 10, remaining 7, expiry of quantity 3
 *     → trigger +3 = 10, direct increment +1 = 11 → clamped to 10 = expected
 *     → PASSES against broken code
 *
 * The same run measured this for real: A2 passed and C1-C3 never executed
 * their assertions, yet the totals still read 11 failures. Headroom is what
 * makes an over-restoration observable.
 */
async function scenario(opts: { autoCancelMinutes?: number; seatTotal?: number; seatRemaining?: number; classStatus?: string } = {}) {
  const tenantId = await createTenant(opts.autoCancelMinutes ?? 0);
  const intakeId = await createIntake(tenantId);
  const classId = await createClassRow(
    tenantId, intakeId, opts.seatTotal ?? 100, opts.seatRemaining ?? 7, opts.classStatus ?? "open",
  );
  return { tenantId, intakeId, classId };
}

// ════════════════════════════════════════════════════════════════════════════
// A. Expiry sweep — seats
// ════════════════════════════════════════════════════════════════════════════

describe("A. expiry sweep", () => {
  it("A1 restores exactly once for a single-class enrollment", async () => {
    const { tenantId, classId } = await scenario({ autoCancelMinutes: 30 });
    await createEnrollment({ tenantId, classId, quantity: 1, minutesAgo: 60 });

    await expireNow();

    expect(await seats(classId)).toBe(8); // 7 + 1
  });

  it("A2 restores exactly `quantity` seats", async () => {
    const { tenantId, classId } = await scenario({ autoCancelMinutes: 30 });
    await createEnrollment({ tenantId, classId, quantity: 3, minutesAgo: 60 });

    await expireNow();

    expect(await seats(classId)).toBe(10); // 7 + 3
  });

  it("A3 restores exactly once per item for a cart enrollment", async () => {
    const { tenantId, classId } = await scenario({ autoCancelMinutes: 30 });
    const enrollId = await createEnrollment({ tenantId, classId: null, minutesAgo: 60 });
    await addItem(enrollId, classId, tenantId, 3);

    await expireNow();

    expect(await seats(classId)).toBe(10); // 7 + 3
  });

  it("A4 is idempotent — a second sweep restores nothing further", async () => {
    const { tenantId, classId } = await scenario({ autoCancelMinutes: 30 });
    await createEnrollment({ tenantId, classId, quantity: 1, minutesAgo: 60 });

    await expireNow();
    const afterFirst = await seats(classId);
    await expireNow();

    expect(await seats(classId)).toBe(afterFirst);
  });

  it("A6 reopens a full class when expiry frees seats", async () => {
    // The sweep no longer sets class status itself — it is delegated to
    // trg_auto_reopen_class, which fires on the seat update the status trigger
    // makes. Untested, this PR could restore capacity while leaving the class
    // closed to enrolment.
    const { tenantId, classId } = await scenario({
      autoCancelMinutes: 30, seatTotal: 10, seatRemaining: 0, classStatus: "full",
    });
    await createEnrollment({ tenantId, classId, quantity: 2, minutesAgo: 60 });

    await expireNow();

    expect(await seats(classId)).toBe(2);
    expect(await classStatus(classId)).toBe("open");
  });

  it("A5 rolls back completely when the sweep raises, and recovers", async () => {
    const { tenantId, classId } = await scenario({ autoCancelMinutes: 30 });
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 1, minutesAgo: 60 });

    // seat_remaining + quantity is evaluated BEFORE LEAST() can clamp, so
    // INT_MAX forces an integer overflow inside the expiry transaction —
    // deterministic, and without any DDL.
    await setSeats(classId, 2147483647, 2147483647);
    const before = { seats: await seats(classId), status: (await enrollmentRow(enrollId)).status };

    const res = await expireNow();

    expect(res).toMatchObject({ success: false });
    expect(await seats(classId)).toBe(before.seats);
    expect((await enrollmentRow(enrollId)).status).toBe(before.status); // NOT rejected

    // Recovery is proven HERE, on the same poisoned fixture. A later test gets
    // a fresh one from afterEach and would only prove ordinary expiry works.
    await setSeats(classId, 100, 50);
    expect(await expireNow()).toMatchObject({ success: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. classes_updated
// ════════════════════════════════════════════════════════════════════════════

describe("B. classes_updated", () => {
  it("B1 counts classes for a direct-only expiry", async () => {
    const { tenantId, classId } = await scenario({ autoCancelMinutes: 30 });
    await createEnrollment({ tenantId, classId, quantity: 1, minutesAgo: 60 });

    expect(await expireNow()).toMatchObject({ expired_count: 1, classes_updated: 1 });
  });

  it("B2 counts classes for a cart-only expiry", async () => {
    const { tenantId, classId } = await scenario({ autoCancelMinutes: 30 });
    const enrollId = await createEnrollment({ tenantId, classId: null, minutesAgo: 60 });
    await addItem(enrollId, classId, tenantId, 2);

    // Carts have class_id NULL — a count that filters on class_id reports 0.
    expect(await expireNow()).toMatchObject({ expired_count: 1, classes_updated: 1 });
  });

  it("B3 counts the union of direct and cart classes for a mixed expiry", async () => {
    const { tenantId, intakeId, classId } = await scenario({ autoCancelMinutes: 30 });
    const classB = await createClassRow(tenantId, intakeId, 10, 7);

    await createEnrollment({ tenantId, classId, quantity: 1, minutesAgo: 60 });
    const cart = await createEnrollment({ tenantId, classId: null, minutesAgo: 60 });
    await addItem(cart, classB, tenantId, 1);

    expect(await expireNow()).toMatchObject({ expired_count: 2, classes_updated: 2 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Manual payment rejection — the real verifyPayment() path
// ════════════════════════════════════════════════════════════════════════════

async function rejectViaVerifyPayment(enrollId: string, tenantId: string) {
  const { verifyPayment } = await import("@/server/payments/verifyPayment");
  const payment = await createPayment(enrollId, tenantId);
  const enrollment = await enrollmentRow(enrollId);

  return verifyPayment({
    action: "reject",
    payment: payment as never,
    enrollment: enrollment as never,
    tenantId,
    tenantInfo: { currency: "MMK", subdomain: null },
    verifier: { verifiedByHuman: null, verifiedByAgent: null },
    rejection_reason: "test rejection",
  });
}

describe("C. manual payment rejection", () => {
  it("C1 restores exactly once for a single-class enrollment", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 2 });

    await rejectViaVerifyPayment(enrollId, tenantId);

    expect(await seats(classId)).toBe(9); // 7 + 2, not 7 + 2 + 2
  });

  it("C2 restores exactly once for a cart enrollment", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId: null });
    await addItem(enrollId, classId, tenantId, 2);

    await rejectViaVerifyPayment(enrollId, tenantId);

    expect(await seats(classId)).toBe(9); // 7 + 2
  });

  it("C3 restores nothing further when the enrollment is already rejected", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 2, status: "rejected" });
    const before = await seats(classId);

    await rejectViaVerifyPayment(enrollId, tenantId);

    expect(await seats(classId)).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. Direct status change — the reference behaviour
// ════════════════════════════════════════════════════════════════════════════

describe("D. direct status change to rejected", () => {
  it("D1 restores exactly once for a single-class enrollment", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 2 });

    await sql(`UPDATE enrollments SET status = 'rejected' WHERE id = $1`, [enrollId]);

    expect(await seats(classId)).toBe(9);
  });

  it("D2 restores exactly once per item for a cart enrollment", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId: null });
    await addItem(enrollId, classId, tenantId, 2);

    await sql(`UPDATE enrollments SET status = 'rejected' WHERE id = $1`, [enrollId]);

    expect(await seats(classId)).toBe(9);
  });

  it("D3 restores nothing further when rejected is re-applied", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 2 });

    await sql(`UPDATE enrollments SET status = 'rejected' WHERE id = $1`, [enrollId]);
    const afterFirst = await seats(classId);
    await sql(`UPDATE enrollments SET status = 'rejected' WHERE id = $1`, [enrollId]);

    expect(await seats(classId)).toBe(afterFirst);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E. Deletion
// ════════════════════════════════════════════════════════════════════════════

describe("E. deletion", () => {
  it("E1 restores exactly once when an active single-class enrollment is deleted", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 2 });

    await sql(`DELETE FROM enrollments WHERE id = $1`, [enrollId]);

    expect(await seats(classId)).toBe(9);
  });

  it("E2 restores exactly once per item when an active cart enrollment is deleted", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId: null });
    await addItem(enrollId, classId, tenantId, 2);

    await sql(`DELETE FROM enrollments WHERE id = $1`, [enrollId]);

    // enrollment_items are CASCADE-deleted; an AFTER DELETE trigger cannot see
    // them, so the restoration must happen BEFORE DELETE.
    expect(await seats(classId)).toBe(9);
  });

  it("E3 restores nothing when an already-rejected single-class enrollment is deleted", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 2, status: "rejected" });
    const before = await seats(classId);

    await sql(`DELETE FROM enrollments WHERE id = $1`, [enrollId]);

    expect(await seats(classId)).toBe(before);
  });

  it("E4 restores nothing when an already-rejected cart enrollment is deleted", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId: null, status: "rejected" });
    await addItem(enrollId, classId, tenantId, 2);
    const before = await seats(classId);

    await sql(`DELETE FROM enrollments WHERE id = $1`, [enrollId]);

    expect(await seats(classId)).toBe(before);
  });

  it("E5 restores nothing further when a rejected enrollment is then deleted", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 2 });

    await sql(`UPDATE enrollments SET status = 'rejected' WHERE id = $1`, [enrollId]);
    const afterReject = await seats(classId);
    await sql(`DELETE FROM enrollments WHERE id = $1`, [enrollId]);

    expect(await seats(classId)).toBe(afterReject);
  });

  it("E7 reopens a full class when a deletion frees seats", async () => {
    // The delete trigger no longer sets status either — same delegation.
    const { tenantId, classId } = await scenario({
      seatTotal: 10, seatRemaining: 0, classStatus: "full",
    });
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 2 });

    await sql(`DELETE FROM enrollments WHERE id = $1`, [enrollId]);

    expect(await seats(classId)).toBe(2);
    expect(await classStatus(classId)).toBe("open");
  });

  it("E6 restores exactly `quantity` when an active enrollment is deleted", async () => {
    const { tenantId, classId } = await scenario();
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 3 });

    await sql(`DELETE FROM enrollments WHERE id = $1`, [enrollId]);

    expect(await seats(classId)).toBe(10);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F. ACL on check_expired_enrollments()
// ════════════════════════════════════════════════════════════════════════════

const INSUFFICIENT_PRIVILEGE = "42501";

describe("F. execute privileges", () => {
  it("F1 allows service_role to execute", async () => {
    const { error } = await admin.rpc("check_expired_enrollments" as never);
    expect(error).toBeNull();
  });

  it("F2 denies anon", async () => {
    const anon = createClient(process.env.SUPABASE_TEST_URL!, process.env.SUPABASE_TEST_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error } = await anon.rpc("check_expired_enrollments" as never);

    // Assert the SPECIFIC denial. "it threw" would also pass for a bad URL,
    // an expired token, or a network failure — a red for the wrong reason.
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("F3 denies an authenticated user", async () => {
    const email = `${uniq()}@example.test`;
    const password = `Pw-${uniq()}!`;

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    expect(createErr).toBeNull();
    made.authUsers.push(created!.user!.id);

    const anon = createClient(process.env.SUPABASE_TEST_URL!, process.env.SUPABASE_TEST_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: session, error: signInErr } = await anon.auth.signInWithPassword({ email, password });

    // A failed sign-in must not masquerade as a passing denial.
    expect(signInErr).toBeNull();
    expect(session.session?.access_token).toBeTruthy();

    const { error } = await anon.rpc("check_expired_enrollments" as never);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G. Invariant
// ════════════════════════════════════════════════════════════════════════════

describe("G. invariant", () => {
  it("G1 never lets seat_remaining exceed seat_total across every path", async () => {
    const { tenantId, classId } = await scenario({ autoCancelMinutes: 30, seatTotal: 10, seatRemaining: 9 });

    // Each path, on a class with only one seat of headroom.
    const expired = await createEnrollment({ tenantId, classId, quantity: 3, minutesAgo: 60 });
    await expireNow();
    expect(await seats(classId)).toBeLessThanOrEqual(10);

    await sql(`DELETE FROM enrollments WHERE id = $1`, [expired]);
    expect(await seats(classId)).toBeLessThanOrEqual(10);

    const direct = await createEnrollment({ tenantId, classId, quantity: 3 });
    await sql(`UPDATE enrollments SET status = 'rejected' WHERE id = $1`, [direct]);
    expect(await seats(classId)).toBeLessThanOrEqual(10);

    const [row] = await sql<{ seat_remaining: number; seat_total: number }>(
      `SELECT seat_remaining, seat_total FROM classes WHERE id = $1`, [classId],
    );
    expect(row.seat_remaining).toBeLessThanOrEqual(row.seat_total);
  });
});
