import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { Pool } from "pg";

// ─── Oversell guard: a late payment must not create a second admission ──────
//
// An enrollment expires (auto-cancel) → `rejected`, its seat is restored and
// resold. Then its payment settles late. Two independent failures combine to
// admit a second customer for one seat:
//
//   1. STATUS — fn_payments_sync_enrollment() and ten application writers set
//      `confirmed` with no state guard, re-confirming the rejected enrollment.
//   2. ADMISSION — issueTicketsForEnrollment() never checks enrollment status,
//      and the scanner accepts on the TICKET's status alone. So a ticket minted
//      for a rejected enrollment scans as valid.
//
// The invariant these tests protect is capacity, not the status flip:
// `seat_remaining` is NOT a witness (update_seat_remaining only restores on
// → rejected; it never decrements on reconfirm), so it reads the same whether
// or not the bug fires. Confirmed DEMAND vs seat_total is the real observable.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Fixture tracking ────────────────────────────────────────────────────────
// Ids recorded at creation, never at teardown: a test failing midway must still
// have recorded what it made. These tests deliberately create rejected and
// oversold states, which would poison neighbours if they leaked.
type Tracked = {
  tenants: string[];
  intakes: string[];
  classes: string[];
  enrollments: string[];
  payments: string[];
};
let made: Tracked;
const fresh = (): Tracked => ({
  tenants: [], intakes: [], classes: [], enrollments: [], payments: [],
});

let seq = 0;
const uniq = () => `og${Date.now().toString(36)}${seq++}`;

// ── Fixture builders ────────────────────────────────────────────────────────

async function createTenant(): Promise<string> {
  const slug = uniq();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1, $2, 'event') RETURNING id`,
    [`Oversell ${slug}`, slug],
  );
  made.tenants.push(row.id);
  return row.id;
}

async function createIntake(tenantId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1, 'Oversell intake', 2026) RETURNING id`,
    [tenantId],
  );
  made.intakes.push(row.id);
  return row.id;
}

/** (intake_id, level) is UNIQUE, so the level is generated, never passed in. */
async function createClassRow(
  tenantId: string,
  intakeId: string,
  seatTotal: number,
  seatRemaining: number,
): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO classes
       (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining, status,
        max_tickets_per_person, event_date)
     VALUES ($1, $2, $5, 100, $3, $4, 'open', 10, now() + interval '30 days')
     RETURNING id`,
    [tenantId, intakeId, seatTotal, seatRemaining, `L${uniq()}`],
  );
  made.classes.push(row.id);
  return row.id;
}

async function createEnrollment(opts: {
  tenantId: string;
  classId: string | null;
  quantity?: number;
  status?: string;
}): Promise<string> {
  const { tenantId, classId, quantity = 1, status = "pending_payment" } = opts;
  const [row] = await sql<{ id: string }>(
    `INSERT INTO enrollments
       (enrollment_ref, tenant_id, student_name_en, phone, class_id, quantity, status)
     VALUES ('', $1, 'Oversell Test', '09000000000', $2, $3, $4::enrollment_status)
     RETURNING id`,
    [tenantId, classId, quantity, status],
  );
  made.enrollments.push(row.id);
  return row.id;
}

async function createPayment(
  enrollmentId: string,
  tenantId: string,
  status = "pending",
): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO payments (enrollment_id, tenant_id, amount, status)
     VALUES ($1, $2, 100, $3::payment_status) RETURNING id`,
    [enrollmentId, tenantId, status],
  );
  made.payments.push(row.id);
  return row.id;
}

// ── Readers ─────────────────────────────────────────────────────────────────

const enrollmentStatus = async (id: string) =>
  (await sql<{ status: string }>(`SELECT status FROM enrollments WHERE id = $1`, [id]))[0].status;

const ticketCount = async (enrollmentId: string) =>
  Number(
    (await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM tickets WHERE enrollment_id = $1`,
      [enrollmentId],
    ))[0].n,
  );

const seatRemaining = async (classId: string) =>
  Number(
    (await sql<{ seat_remaining: number }>(
      `SELECT seat_remaining FROM classes WHERE id = $1`, [classId],
    ))[0].seat_remaining,
  );

/**
 * Confirmed demand for one class — the real oversell observable.
 * Scoped to the fixture's class id, never a global aggregate, so other tests'
 * rows cannot perturb it. Counts single-class and cart demand separately; they
 * do not overlap (a single-class enrollment has class_id set and no items).
 */
const confirmedDemand = async (classId: string) =>
  Number(
    (await sql<{ demand: string }>(
      `SELECT (
         COALESCE((SELECT SUM(COALESCE(e.quantity, 1)) FROM enrollments e
                   WHERE e.class_id = $1 AND e.status = 'confirmed'), 0)
       + COALESCE((SELECT SUM(ei.quantity) FROM enrollment_items ei
                   JOIN enrollments e2 ON e2.id = ei.enrollment_id
                   WHERE ei.class_id = $1 AND e2.status = 'confirmed'), 0)
       )::text AS demand`,
      [classId],
    ))[0].demand,
  );

const issueTickets = async (enrollmentId: string) => {
  const { issueTicketsForEnrollment } = await import("@/server/tickets/issueTickets");
  return issueTicketsForEnrollment(enrollmentId);
};

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1");
});

afterEach(async () => {
  // FK-safe, runs after failures, and errors are NOT swallowed: a leaked
  // pending_payment row would be swept by a later expiry test and fail it for
  // an unrelated reason.
  const { tenants, intakes, classes, enrollments, payments } = made;
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
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

/** One-seat class with the seat already taken by `original`, then resold. */
async function oversellScenario() {
  const tenantId = await createTenant();
  const intakeId = await createIntake(tenantId);
  const classId = await createClassRow(tenantId, intakeId, 1, 0); // 1 seat, taken

  const original = await createEnrollment({ tenantId, classId, quantity: 1 });
  const paymentId = await createPayment(original, tenantId);

  // Expiry rejects it; the seat trigger restores the seat.
  await sql(`UPDATE enrollments SET status = 'rejected' WHERE id = $1`, [original]);

  // The restored seat is resold and confirmed.
  const replacement = await createEnrollment({ tenantId, classId, quantity: 1 });
  await sql(`UPDATE enrollments SET status = 'confirmed' WHERE id = $1`, [replacement]);

  return { tenantId, classId, original, replacement, paymentId };
}

// ════════════════════════════════════════════════════════════════════════════
// O — the admission oversell
// ════════════════════════════════════════════════════════════════════════════

describe("O. late payment must not create a second admission", () => {
  it("O1 late payment via the payment trigger does not oversell", async () => {
    const { classId, original, paymentId } = await oversellScenario();

    // The late settlement: payment → verified fires fn_payments_sync_enrollment.
    await sql(`UPDATE payments SET status = 'verified' WHERE id = $1`, [paymentId]);
    await issueTickets(original);

    expect(await enrollmentStatus(original)).toBe("rejected");
    expect(await confirmedDemand(classId)).toBeLessThanOrEqual(1);
    expect(await ticketCount(original)).toBe(0);
  });

  it("O2 late confirm via a direct app-style update does not oversell", async () => {
    const { classId, original } = await oversellScenario();

    // What all ten application writers do: an unconditional status update.
    await sql(`UPDATE enrollments SET status = 'confirmed' WHERE id = $1`, [original]);
    await issueTickets(original);

    expect(await enrollmentStatus(original)).toBe("rejected");
    expect(await confirmedDemand(classId)).toBeLessThanOrEqual(1);
    expect(await ticketCount(original)).toBe(0);
  });

  it("O3 issueTickets mints nothing for a rejected enrollment", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const classId = await createClassRow(tenantId, intakeId, 10, 9);
    const enrollId = await createEnrollment({ tenantId, classId, status: "rejected" });

    await issueTickets(enrollId);

    expect(await ticketCount(enrollId)).toBe(0);
  });

  it("O4 rejected cannot be laundered through partial_payment", async () => {
    const { classId, original } = await oversellScenario();

    // verifyPayment()'s request_remaining sets partial_payment with no state
    // guard; a guard blocking only rejected → confirmed would let this through,
    // because the second hop's OLD.status is partial_payment.
    await sql(`UPDATE enrollments SET status = 'partial_payment' WHERE id = $1`, [original]);
    await sql(`UPDATE enrollments SET status = 'confirmed' WHERE id = $1`, [original]);
    await issueTickets(original);

    expect(await enrollmentStatus(original)).toBe("rejected");
    expect(await confirmedDemand(classId)).toBeLessThanOrEqual(1);
    expect(await ticketCount(original)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G — the happy paths and every branch of the recreated payment trigger
// ════════════════════════════════════════════════════════════════════════════

describe("G. existing behaviour is preserved", () => {
  async function eligibleEnrollment(status: string) {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const classId = await createClassRow(tenantId, intakeId, 10, 8);
    const enrollId = await createEnrollment({ tenantId, classId, quantity: 2, status });
    const paymentId = await createPayment(enrollId, tenantId);
    return { tenantId, classId, enrollId, paymentId };
  }

  it("G1 pending_payment → verified payment → confirmed, ticket issued", async () => {
    const { enrollId, paymentId } = await eligibleEnrollment("pending_payment");
    await sql(`UPDATE payments SET status = 'verified' WHERE id = $1`, [paymentId]);
    expect(await enrollmentStatus(enrollId)).toBe("confirmed");
    await issueTickets(enrollId);
    expect(await ticketCount(enrollId)).toBe(2);
  });

  it("G2 payment_submitted → verified payment → confirmed", async () => {
    const { enrollId, paymentId } = await eligibleEnrollment("payment_submitted");
    await sql(`UPDATE payments SET status = 'verified' WHERE id = $1`, [paymentId]);
    expect(await enrollmentStatus(enrollId)).toBe("confirmed");
  });

  it("G3 partial_payment → verified payment → confirmed", async () => {
    const { enrollId, paymentId } = await eligibleEnrollment("partial_payment");
    await sql(`UPDATE payments SET status = 'verified' WHERE id = $1`, [paymentId]);
    expect(await enrollmentStatus(enrollId)).toBe("confirmed");
  });

  it("G4 inserting a pending payment advances the enrollment to payment_submitted", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const classId = await createClassRow(tenantId, intakeId, 10, 9);
    const enrollId = await createEnrollment({ tenantId, classId });
    await createPayment(enrollId, tenantId, "pending");
    expect(await enrollmentStatus(enrollId)).toBe("payment_submitted");
  });

  it("G5 rejecting a payment rejects the enrollment and restores its seat once", async () => {
    const { classId, enrollId, paymentId } = await eligibleEnrollment("pending_payment");
    const before = await seatRemaining(classId);
    await sql(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [paymentId]);
    expect(await enrollmentStatus(enrollId)).toBe("rejected");
    expect(await seatRemaining(classId)).toBe(before + 2);
  });

  it("G6 cart rejection restores each item seat once", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const classA = await createClassRow(tenantId, intakeId, 10, 8);
    const classB = await createClassRow(tenantId, intakeId, 10, 9);
    const enrollId = await createEnrollment({ tenantId, classId: null });
    await sql(
      `INSERT INTO enrollment_items (enrollment_id, class_id, tenant_id, fee_amount, quantity)
       VALUES ($1,$2,$3,100,2), ($1,$4,$3,100,1)`,
      [enrollId, classA, tenantId, classB],
    );
    await sql(`UPDATE enrollments SET status = 'rejected' WHERE id = $1`, [enrollId]);
    expect(await seatRemaining(classA)).toBe(10);
    expect(await seatRemaining(classB)).toBe(10);
  });

  it("G7 issueTickets still issues one ticket per seat for a confirmed enrollment", async () => {
    const { enrollId } = await eligibleEnrollment("pending_payment");
    await sql(`UPDATE enrollments SET status = 'confirmed' WHERE id = $1`, [enrollId]);
    await issueTickets(enrollId);
    expect(await ticketCount(enrollId)).toBe(2);
  });
});
