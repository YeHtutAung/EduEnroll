import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { Pool } from "pg";
import { mintPriorityToken, hashPriorityToken } from "@/lib/interest/token";

// ─── Carts that name the same class twice ───────────────────────────────────
//
// submit_cart_enrollment used to validate each submitted item on its own, so a
// cart repeating a class_id was never measured as a whole. Two symptoms, one
// cause, both reproduced against this stack before the fix
// (20260830120200_cart_aggregates_duplicate_classes.sql):
//
//   max_tickets_per_person = 2, seat_remaining = 100
//     one item, quantity 5              -> EXCEEDS_MAX_TICKETS   (correct)
//     three items, quantity 2 each      -> success, quantity 6   (WRONG)
//
//   seat_remaining = 6, cart [quantity 5, quantity 5]
//     -> INTERNAL_ERROR "violates check constraint classes_seats_check"
//
// The seats case never oversold — classes_seats_check caught the aggregate and
// rolled the whole transaction back — so what it produced was a confusing
// error that also handed a constraint name to a public caller. The tickets
// case is the consequential one: no error, no rollback, seats decremented, and
// for an event tenant that cap is the anti-scalping control.
//
// D1 and D2 below are the discriminating cases. Both were confirmed RED
// against the pre-fix body and GREEN against the migration's, byte-exact — see
// the task record. A test that passes against the unfixed function proves
// nothing, and this repository has shipped that mistake before.
//
// Requires the isolated local stack. See setup.ts for the local-only guards.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Fixture tracking ────────────────────────────────────────────────────────
// Ids recorded at creation, never at teardown — a test failing midway must
// still have recorded what it made.
type Tracked = {
  tenants: string[];
  intakes: string[];
  classes: string[];
  interests: string[];
};
let made: Tracked;

const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], interests: [] });

let seq = 0;
const uniq = () => `cd${Date.now().toString(36)}${seq++}`;

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

// ── Fixture builders ────────────────────────────────────────────────────────

async function createTenant(): Promise<string> {
  const slug = uniq();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1, $2, 'event') RETURNING id`,
    [`Cart dup ${slug}`, slug],
  );
  made.tenants.push(row.id);
  return row.id;
}

async function createIntake(tenantId: string, priorityOpenAt?: string | null): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year, priority_open_at)
     VALUES ($1, 'Cart dup intake', 2026, $2) RETURNING id`,
    [tenantId, priorityOpenAt ?? null],
  );
  made.intakes.push(row.id);
  return row.id;
}

/**
 * (intake_id, level) is UNIQUE, so the level is generated, never passed in.
 * Every class is created 'open': the cart RPC rejects a non-open class before
 * it reaches any of the rules under test here.
 */
async function createClass(
  tenantId: string,
  intakeId: string,
  opts: {
    seatTotal?: number;
    seatRemaining?: number;
    maxTickets?: number;
    fee?: number;
    enrollmentOpenAt?: string | null;
  } = {},
): Promise<string> {
  const {
    seatTotal = 100,
    seatRemaining = seatTotal,
    maxTickets = 10,
    fee = 100,
    enrollmentOpenAt = null,
  } = opts;
  const [row] = await sql<{ id: string }>(
    `INSERT INTO classes
       (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining, status,
        max_tickets_per_person, enrollment_open_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8)
     RETURNING id`,
    [tenantId, intakeId, `L${uniq()}`, fee, seatTotal, seatRemaining, maxTickets, enrollmentOpenAt],
  );
  made.classes.push(row.id);
  return row.id;
}

/**
 * Returns the raw token; the row stores only its hash, as production does.
 *
 * The signup cutoff trigger (20260830120000) forbids creating an interest row
 * once the intake's priority window has already opened — rightly, because in
 * production every row is written while the window is still in the future.
 * So the row is built the way production builds it, by moving the schedule
 * around the insert rather than by suspending the rule. This is the same dance
 * priority-window.db.test.ts documents at length; the abbreviated version is
 * enough here because every fixture in this file has at most one gated tier
 * and none is on sale yet:
 *
 *   1. priority_open_at is moved to the earliest tier sale time (or an hour
 *      out when no tier has one) — future, so the cutoff admits the insert,
 *      and no later than any tier, so the window trigger is satisfied.
 *   2. The row is inserted with the cutoff live.
 *   3. priority_open_at is restored. It can only move earlier from step 1, and
 *      moving it earlier cannot violate the window invariant.
 *
 * All in one transaction, so a failure anywhere rolls the schedule back with
 * the insert.
 */
async function createInterest(intakeId: string, tenantId: string, email: string): Promise<string> {
  const minted = mintPriorityToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      rows: [before],
    } = await client.query(
      `SELECT i.priority_open_at,
              (SELECT min(enrollment_open_at) FROM classes WHERE intake_id = i.id) AS earliest
         FROM intakes i WHERE i.id = $1`,
      [intakeId],
    );
    const openAt: Date = before.earliest ?? new Date(Date.now() + 3_600_000);
    await client.query(`UPDATE intakes SET priority_open_at = $2 WHERE id = $1`, [
      intakeId,
      openAt,
    ]);

    const { rows } = await client.query(
      `INSERT INTO event_interest (tenant_id, intake_id, name, email, token_hash, token_prefix)
       VALUES ($1, $2, 'Cart dup interest', $3, $4, $5) RETURNING id`,
      [tenantId, intakeId, email, minted.tokenHash, minted.tokenPrefix],
    );

    await client.query(`UPDATE intakes SET priority_open_at = $2 WHERE id = $1`, [
      intakeId,
      before.priority_open_at,
    ]);

    await client.query("COMMIT");
    made.interests.push(rows[0].id as string);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return minted.token;
}

// ── Callers and readers ─────────────────────────────────────────────────────

type CartItem = { class_id: string; quantity?: number };
type ItemOut = {
  class_id: string;
  class_level: string;
  quantity: number;
  fee_amount: number;
  subtotal: number;
};
type RpcResult = Record<string, unknown> & {
  success: boolean;
  error?: string;
  detail?: string;
  quantity?: number;
  total_fee?: number;
  items?: ItemOut[];
  enrollment_id?: string;
};

const submitCart = async (
  items: CartItem[],
  tenantId: string,
  tokenHash: string | null = null,
): Promise<RpcResult> =>
  (
    await sql<{ result: RpcResult }>(
      `SELECT public.submit_cart_enrollment($1::jsonb, $2, $3) AS result`,
      [JSON.stringify(items), tenantId, tokenHash],
    )
  )[0].result;

const seatRemaining = async (classId: string) =>
  Number(
    (
      await sql<{ seat_remaining: number }>(`SELECT seat_remaining FROM classes WHERE id = $1`, [
        classId,
      ])
    )[0].seat_remaining,
  );

/** enrollment_items for one cart, ordered so assertions are deterministic. */
const itemRows = async (enrollmentId: string) =>
  sql<{ class_id: string; quantity: number }>(
    `SELECT class_id, quantity FROM enrollment_items
      WHERE enrollment_id = $1 ORDER BY class_id`,
    [enrollmentId],
  );

/** Every enrollment the tenant has, so "nothing was created" is checkable. */
const enrollmentCount = async (tenantId: string) =>
  Number(
    (
      await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM enrollments WHERE tenant_id = $1`,
        [tenantId],
      )
    )[0].n,
  );

const interestRowsForIntake = async (intakeId: string) =>
  sql<{
    id: string;
    first_used_at: string | null;
    first_converted_enrollment_id: string | null;
  }>(
    `SELECT id, first_used_at, first_converted_enrollment_id
       FROM event_interest WHERE intake_id = $1`,
    [intakeId],
  );

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1"); // fail fast on a bad DATABASE_URL
});

afterEach(async () => {
  // Enrollments are swept BY TENANT, deliberately not by a tracked id list: a
  // cart that returned failure still may have created rows in a path this file
  // is asserting did NOT, and a list can only record what the test saw.
  // enrollments_class_id_fkey is NO ACTION, so a stray row would make the
  // classes delete throw, abort the rest of this hook, and strand a
  // pending_payment enrollment for a later file's global
  // check_expired_enrollments() to trip over.
  const { tenants, intakes, classes, interests } = made;
  if (tenants.length) {
    await sql(`DELETE FROM enrollment_items WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await sql(`DELETE FROM enrollments WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
  }
  if (interests.length)
    await sql(`DELETE FROM event_interest WHERE id = ANY($1::uuid[])`, [interests]);
  if (classes.length) await sql(`DELETE FROM classes WHERE id = ANY($1::uuid[])`, [classes]);
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

// ════════════════════════════════════════════════════════════════════════════
// D. The defect — duplicates must not multiply a per-item limit
// ════════════════════════════════════════════════════════════════════════════

describe("D. duplicate class_ids are aggregated before validation", () => {
  it("D1 three items of quantity 2 against a cap of 2 are refused as one demand of 6", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const classId = await createClass(tenantId, intakeId, {
      seatTotal: 100,
      seatRemaining: 100,
      maxTickets: 2,
    });

    // The control: the same total in one item is — and always was — refused.
    const single = await submitCart([{ class_id: classId, quantity: 5 }], tenantId);
    expect(single).toMatchObject({ success: false, error: "EXCEEDS_MAX_TICKETS", max: 2 });

    // The discriminating case. Pre-fix this returned success with quantity 6.
    const split = await submitCart(
      [
        { class_id: classId, quantity: 2 },
        { class_id: classId, quantity: 2 },
        { class_id: classId, quantity: 2 },
      ],
      tenantId,
    );

    expect(split).toMatchObject({
      success: false,
      error: "EXCEEDS_MAX_TICKETS",
      class_id: classId,
      max: 2,
    });
    // Phase 1 is all-or-nothing: it returns before Phase 2 creates anything.
    expect(await seatRemaining(classId)).toBe(100);
    expect(await enrollmentCount(tenantId)).toBe(0);
  });

  it("D2 an aggregate over capacity is NOT_ENOUGH_SEATS, not a leaked constraint name", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    // maxTickets high enough that the seat rule, not the cap, is what must fire.
    const classId = await createClass(tenantId, intakeId, {
      seatTotal: 6,
      seatRemaining: 6,
      maxTickets: 10,
    });

    const result = await submitCart(
      [
        { class_id: classId, quantity: 5 },
        { class_id: classId, quantity: 5 },
      ],
      tenantId,
    );

    // The normal payload for this branch — class_id, class_level, and the
    // seat count the caller can act on.
    expect(result).toMatchObject({
      success: false,
      error: "NOT_ENOUGH_SEATS",
      class_id: classId,
      seat_remaining: 6,
    });
    expect(typeof result.class_level).toBe("string");

    // Pre-fix this was INTERNAL_ERROR with detail
    // "…violates check constraint \"classes_seats_check\"". The error code
    // alone is not enough: assert the constraint name is nowhere in the
    // payload, whatever key it might arrive under.
    expect(result.error).not.toBe("INTERNAL_ERROR");
    expect(result).not.toHaveProperty("detail");
    expect(JSON.stringify(result)).not.toMatch(/classes_seats_check|check constraint/i);

    // The constraint used to roll this back, so seats were already correct.
    // Asserted anyway — the whole point is that the refusal now happens in
    // Phase 1, before anything is attempted.
    expect(await seatRemaining(classId)).toBe(6);
    expect(await enrollmentCount(tenantId)).toBe(0);
  });

  it("D3 duplicates within the limits become one item row with the summed quantity", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const classId = await createClass(tenantId, intakeId, {
      seatTotal: 10,
      seatRemaining: 10,
      maxTickets: 6,
      fee: 100,
    });

    const result = await submitCart(
      [
        { class_id: classId, quantity: 2 },
        { class_id: classId, quantity: 3 },
      ],
      tenantId,
    );

    expect(result).toMatchObject({ success: true, quantity: 5, total_fee: 500 });

    // The shape change this fix introduces, asserted rather than assumed:
    // one entry per DISTINCT class, not one per submitted item.
    expect(result.items).toHaveLength(1);
    expect(result.items![0]).toMatchObject({
      class_id: classId,
      quantity: 5,
      fee_amount: 100,
      subtotal: 500,
    });

    // One row in the table, and the seat column moved exactly once.
    const rows = await itemRows(result.enrollment_id!);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(5);
    expect(await seatRemaining(classId)).toBe(5);
  });

  it("D4 items with no quantity each count as 1 when aggregated", async () => {
    // The loops defaulted a missing quantity to 1; the aggregation has to
    // default per element, not per group, or two bare items would sum to 1.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const classId = await createClass(tenantId, intakeId, {
      seatTotal: 10,
      seatRemaining: 10,
      maxTickets: 6,
    });

    const result = await submitCart(
      [{ class_id: classId }, { class_id: classId }, { class_id: classId }],
      tenantId,
    );

    expect(result).toMatchObject({ success: true, quantity: 3 });
    expect(result.items).toHaveLength(1);
    expect(result.items![0].quantity).toBe(3);
    expect(await seatRemaining(classId)).toBe(7);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// R. Regression — a cart with no repeated class must behave exactly as before
// ════════════════════════════════════════════════════════════════════════════

describe("R. carts without duplicates are unchanged", () => {
  it("R1 a two-class cart decrements each seat once and returns one item each", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const classA = await createClass(tenantId, intakeId, {
      seatTotal: 10,
      seatRemaining: 10,
      maxTickets: 5,
      fee: 100,
    });
    const classB = await createClass(tenantId, intakeId, {
      seatTotal: 10,
      seatRemaining: 9,
      maxTickets: 5,
      fee: 250,
    });

    const result = await submitCart(
      [
        { class_id: classA, quantity: 2 },
        { class_id: classB, quantity: 1 },
      ],
      tenantId,
    );

    expect(result).toMatchObject({
      success: true,
      tenant_id: tenantId,
      quantity: 3,
      total_fee: 2 * 100 + 1 * 250,
    });
    expect(result.items).toHaveLength(2);

    const byClass = Object.fromEntries(result.items!.map((i) => [i.class_id, i]));
    expect(byClass[classA]).toMatchObject({ quantity: 2, fee_amount: 100, subtotal: 200 });
    expect(byClass[classB]).toMatchObject({ quantity: 1, fee_amount: 250, subtotal: 250 });

    expect(await seatRemaining(classA)).toBe(8);
    expect(await seatRemaining(classB)).toBe(8);

    const rows = await itemRows(result.enrollment_id!);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.quantity)).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("R2 a per-item cap breach in a cart with no duplicates still refuses, nothing moves", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const classA = await createClass(tenantId, intakeId, {
      seatTotal: 10,
      seatRemaining: 10,
      maxTickets: 2,
    });
    const classB = await createClass(tenantId, intakeId, {
      seatTotal: 10,
      seatRemaining: 10,
      maxTickets: 2,
    });

    const result = await submitCart(
      [
        { class_id: classA, quantity: 1 },
        { class_id: classB, quantity: 3 },
      ],
      tenantId,
    );

    expect(result).toMatchObject({
      success: false,
      error: "EXCEEDS_MAX_TICKETS",
      class_id: classB,
      max: 2,
    });
    expect(await seatRemaining(classA)).toBe(10);
    expect(await seatRemaining(classB)).toBe(10);
    expect(await enrollmentCount(tenantId)).toBe(0);
  });

  it("R3 a cart naming a class of another tenant is still CROSS_TENANT", async () => {
    const tenantA = await createTenant();
    const intakeA = await createIntake(tenantA);
    const classA = await createClass(tenantA, intakeA, { seatTotal: 10, seatRemaining: 10 });

    const tenantB = await createTenant();
    const intakeB = await createIntake(tenantB);
    const classB = await createClass(tenantB, intakeB, { seatTotal: 10, seatRemaining: 10 });

    const result = await submitCart(
      [
        { class_id: classA, quantity: 1 },
        { class_id: classB, quantity: 1 },
      ],
      tenantA,
    );

    expect(result).toMatchObject({ success: false, error: "CROSS_TENANT" });
    expect(await seatRemaining(classA)).toBe(10);
    expect(await seatRemaining(classB)).toBe(10);
    expect(await enrollmentCount(tenantA)).toBe(0);
    expect(await enrollmentCount(tenantB)).toBe(0);
  });

  it("R4 an empty cart is still EMPTY_CART", async () => {
    const tenantId = await createTenant();
    expect(await submitCart([], tenantId)).toMatchObject({
      success: false,
      error: "EMPTY_CART",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P. The priority gate still works through an aggregated cart
// ════════════════════════════════════════════════════════════════════════════

describe("P. priority gate through an aggregated cart", () => {
  /** A gated tier: the intake's window is open, the tier's public sale is not. */
  async function gatedTier(seats: number, maxTickets: number) {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(tenantId, intakeId, {
      seatTotal: seats,
      seatRemaining: seats,
      maxTickets,
      enrollmentOpenAt: hoursFromNow(1),
    });
    return { tenantId, intakeId, classId };
  }

  it("P1 a valid token admits an aggregated cart, seat drops once by the summed total", async () => {
    const { tenantId, intakeId, classId } = await gatedTier(10, 6);
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitCart(
      [
        { class_id: classId, quantity: 2 },
        { class_id: classId, quantity: 2 },
      ],
      tenantId,
      hashPriorityToken(token),
    );

    expect(result).toMatchObject({ success: true, quantity: 4 });
    expect(result.items).toHaveLength(1);
    expect(await seatRemaining(classId)).toBe(6);

    // The redemption transition is stamped once, against the cart's own
    // enrollment — aggregation must not have turned it into one stamp per
    // submitted item, nor skipped it.
    const rows = await interestRowsForIntake(intakeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].first_used_at).not.toBeNull();
    expect(rows[0].first_converted_enrollment_id).toBe(result.enrollment_id);
  });

  it("P2 no token still refuses an aggregated cart before the sale opens", async () => {
    const { tenantId, intakeId, classId } = await gatedTier(10, 6);
    await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitCart(
      [
        { class_id: classId, quantity: 2 },
        { class_id: classId, quantity: 2 },
      ],
      tenantId,
      null,
    );

    expect(result).toMatchObject({
      success: false,
      error: "ENROLLMENT_NOT_OPEN",
      class_id: classId,
    });
    expect(await seatRemaining(classId)).toBe(10);
    expect(await enrollmentCount(tenantId)).toBe(0);

    const rows = await interestRowsForIntake(intakeId);
    expect(rows[0].first_used_at).toBeNull();
  });

  it("P3 the cap is enforced on the aggregate even when a valid token admitted the cart", async () => {
    // A token is a head start, not a licence: the gate opening the tier must
    // not move the ticket cap out of the aggregated cart's way.
    const { tenantId, intakeId, classId } = await gatedTier(50, 2);
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitCart(
      [
        { class_id: classId, quantity: 2 },
        { class_id: classId, quantity: 2 },
      ],
      tenantId,
      hashPriorityToken(token),
    );

    expect(result).toMatchObject({
      success: false,
      error: "EXCEEDS_MAX_TICKETS",
      class_id: classId,
      max: 2,
    });
    expect(await seatRemaining(classId)).toBe(50);
    expect(await enrollmentCount(tenantId)).toBe(0);

    // Refused in Phase 1, so no redemption was stamped either.
    const rows = await interestRowsForIntake(intakeId);
    expect(rows[0].first_used_at).toBeNull();
    expect(rows[0].first_converted_enrollment_id).toBeNull();
  });
});
