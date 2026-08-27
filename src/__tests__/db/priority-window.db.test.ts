import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Pool, Client } from "pg";
import { mintPriorityToken, hashPriorityToken } from "@/lib/interest/token";

// ─── Event interest + priority window: database integration tests ──────────
// Covers two pieces of 20260827120000_event_interest_priority_window.sql that
// cannot be trusted from reading alone:
//
//   1. The window trigger (assert_priority_window_valid, fired from both the
//      intakes side and the classes side) — a cross-table invariant that no
//      single-table CHECK can express.
//   2. The gate (priority_access_granted) — the function the enrollment RPCs
//      will consult in a later task. Its behaviour on revoked, cross-intake,
//      and superseded tokens is exactly the kind of edge case that reads fine
//      and fails at the first real call, per this project's own history with
//      pg_advisory_xact_lock in this same migration.
//
// Requires the isolated local stack. See setup.ts for the local-only guards.
//
// TIME-MARGIN RULE: every fixture timestamp uses hoursFromNow(±1) / (±2) —
// roughly an hour of margin either side of "now", never a near-instant
// boundary. This is deliberate, not laziness: with a continuously advancing
// clock, a `>` vs `>=` slip on a timestamp predicate is unobservable in
// practice, because by the time the gate evaluates, now() has already moved
// past the boundary either way. A sub-second-margin fixture would not
// discriminate that bug — it would only add flake risk to a suite whose
// value depends on people trusting a red result. Do not tighten these.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Fixture tracking ────────────────────────────────────────────────────────
// Ids recorded at creation, never at teardown — see seat-restoration.db.test.ts
// for why. event_interest rows cascade-delete with their intake (composite FK
// ON DELETE CASCADE), but they are tracked and deleted explicitly anyway: a
// test that fails between creating the interest row and creating the intake
// it points at must not depend on ordering it never reached.
type Tracked = {
  tenants: string[];
  intakes: string[];
  classes: string[];
  interests: string[];
  enrollments: string[];
};
let made: Tracked;

const fresh = (): Tracked => ({
  tenants: [], intakes: [], classes: [], interests: [], enrollments: [],
});

let seq = 0;
const uniq = () => `t${Date.now().toString(36)}${seq++}`;

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

// ── Fixture builders ────────────────────────────────────────────────────────

async function createTenant(): Promise<string> {
  const slug = uniq();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain) VALUES ($1, $2) RETURNING id`,
    [`Test ${slug}`, slug],
  );
  made.tenants.push(row.id);
  return row.id;
}

/** priorityOpenAt: an ISO timestamp, or null/undefined to leave it unset. */
async function createIntake(tenantId: string, priorityOpenAt?: string | null): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year, priority_open_at)
     VALUES ($1, 'Test intake', 2026, $2) RETURNING id`,
    [tenantId, priorityOpenAt ?? null],
  );
  made.intakes.push(row.id);
  return row.id;
}

async function createClass(
  intakeId: string,
  tenantId: string,
  opts: {
    enrollmentOpenAt?: string | null;
    seatTotal?: number;
    seatRemaining?: number;
    // Table default is 'draft'. A. and B. only ever call priority_access_granted,
    // which never reads status, so they never needed this. The RPC-calling
    // C/D/E groups below do — submit_enrollment/submit_cart_enrollment both
    // reject a non-'open' class before the gate is even reached — so they
    // pass status: "open" explicitly.
    status?: string;
  } = {},
): Promise<string> {
  const { enrollmentOpenAt = null, seatTotal = 10, seatRemaining = 10, status = "draft" } = opts;
  // (intake_id, level) is UNIQUE — level generated so two classes in one
  // intake never collide, same as seat-restoration.db.test.ts.
  const [row] = await sql<{ id: string }>(
    `INSERT INTO classes
       (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining, enrollment_open_at, status)
     VALUES ($1, $2, $6, 100, $3, $4, $5, $7::class_status) RETURNING id`,
    [tenantId, intakeId, seatTotal, seatRemaining, enrollmentOpenAt, `L${uniq()}`, status],
  );
  made.classes.push(row.id);
  return row.id;
}

/** Returns the raw token; the row stores only its hash, as production does. */
async function createInterest(intakeId: string, tenantId: string, email: string): Promise<string> {
  const minted = mintPriorityToken();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO event_interest (tenant_id, intake_id, name, email, token_hash, token_prefix)
     VALUES ($1, $2, 'Test Interest', $3, $4, $5) RETURNING id`,
    [tenantId, intakeId, email, minted.tokenHash, minted.tokenPrefix],
  );
  made.interests.push(row.id);
  return minted.token;
}

// ── Readers ─────────────────────────────────────────────────────────────────

const granted = async (classId: string, tokenHash: string) =>
  (await sql<{ granted: boolean }>(
    `SELECT public.priority_access_granted($1, $2) AS granted`,
    [classId, tokenHash],
  ))[0].granted;

const seatRemaining = async (classId: string) =>
  Number(
    (await sql<{ seat_remaining: number }>(
      `SELECT seat_remaining FROM classes WHERE id = $1`,
      [classId],
    ))[0].seat_remaining,
  );

/** Every event_interest row for an intake — deliberately the whole shape, not
 *  a single lookup, so D-group tests can assert "exactly one row changed". */
const interestRowsForIntake = async (intakeId: string) =>
  sql<{
    id: string;
    first_used_at: string | null;
    first_converted_enrollment_id: string | null;
    superseded_token_hash: string | null;
    superseded_expires_at: string | null;
  }>(
    `SELECT id, first_used_at, first_converted_enrollment_id,
            superseded_token_hash, superseded_expires_at
     FROM event_interest WHERE intake_id = $1`,
    [intakeId],
  );

type RpcResult = Record<string, unknown> & { success: boolean; error?: string };

/** Tracks the created enrollment id (if any) so afterEach can clean it up. */
async function submitEnrollment(
  classId: string,
  tokenHash: string | null,
  quantity = 1,
  idempotencyKey: string | null = null,
): Promise<RpcResult> {
  const [row] = await sql<{ result: RpcResult }>(
    `SELECT public.submit_enrollment($1, $2, $3, $4) AS result`,
    [classId, idempotencyKey, quantity, tokenHash],
  );
  if (row.result.success && row.result.enrollment_id) {
    made.enrollments.push(String(row.result.enrollment_id));
  }
  return row.result;
}

/** Same tracking discipline as submitEnrollment, for the cart RPC. */
async function submitCartEnrollment(
  items: Array<{ class_id: string; quantity?: number }>,
  tenantId: string,
  tokenHash: string | null,
): Promise<RpcResult> {
  const [row] = await sql<{ result: RpcResult }>(
    `SELECT public.submit_cart_enrollment($1::jsonb, $2, $3) AS result`,
    [JSON.stringify(items), tenantId, tokenHash],
  );
  if (row.result.success && row.result.enrollment_id) {
    made.enrollments.push(String(row.result.enrollment_id));
  }
  return row.result;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1"); // fail fast on a bad DATABASE_URL
});

afterEach(async () => {
  // FK-safe order. Runs even when the test failed, hence the recorded ids.
  // enrollments come first: event_interest.first_converted_enrollment_id is
  // ON DELETE SET NULL, so deleting enrollments before interests is safe, and
  // a leaked pending_payment enrollment would otherwise be swept up by a later
  // file's check_expired_enrollments() call and fail it for an unrelated
  // reason (check_expired_enrollments() is global).
  const { tenants, intakes, classes, interests, enrollments } = made;
  if (enrollments.length) {
    await sql(`DELETE FROM enrollment_items WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM enrollments WHERE id = ANY($1::uuid[])`, [enrollments]);
  }
  if (interests.length) await sql(`DELETE FROM event_interest WHERE id = ANY($1::uuid[])`, [interests]);
  if (classes.length) await sql(`DELETE FROM classes WHERE id = ANY($1::uuid[])`, [classes]);
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

// ════════════════════════════════════════════════════════════════════════════
// A. Window trigger — assert_priority_window_valid
// ════════════════════════════════════════════════════════════════════════════

describe("A. window trigger", () => {
  it("A1 raises when priority_open_at is set later than a tier's enrollment_open_at", async () => {
    const tenantId = await createTenant();
    // Intake starts with priority_open_at unset (exempt), so the class can be
    // created first with an enrollment_open_at that will later be violated.
    const intakeId = await createIntake(tenantId, null);
    await createClass(intakeId, tenantId, { enrollmentOpenAt: hoursFromNow(1) });

    await expect(
      sql(`UPDATE intakes SET priority_open_at = $2 WHERE id = $1`, [intakeId, hoursFromNow(2)]),
    ).rejects.toThrow(/priority_open_at must not be later/);
  });

  it("A2 raises from the class side when enrollment_open_at is moved earlier than priority_open_at", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(1));
    // Valid at creation: enrollment_open_at is after priority_open_at.
    const classId = await createClass(intakeId, tenantId, { enrollmentOpenAt: hoursFromNow(2) });

    await expect(
      sql(`UPDATE classes SET enrollment_open_at = $2 WHERE id = $1`, [classId, hoursFromNow(0)]),
    ).rejects.toThrow(/priority_open_at must not be later/);
  });

  it("A3 exempts a tier with enrollment_open_at IS NULL", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(1));

    await expect(
      createClass(intakeId, tenantId, { enrollmentOpenAt: null }),
    ).resolves.toEqual(expect.any(String));
  });

  it("A4 raises when a class is reparented onto an intake it would violate", async () => {
    // trg_assert_priority_window_from_class explicitly re-validates when
    // NEW.intake_id differs from OLD.intake_id — a separate branch from the
    // enrollment_open_at-only edits A1-A3 exercise, so it needs its own case.
    const tenantId = await createTenant();
    // Origin intake is exempt (priority_open_at unset), so the class can be
    // created there with a time that will only become a problem once moved.
    const origin = await createIntake(tenantId, null);
    const target = await createIntake(tenantId, hoursFromNow(2));
    const classId = await createClass(origin, tenantId, { enrollmentOpenAt: hoursFromNow(1) });

    await expect(
      sql(`UPDATE classes SET intake_id = $2 WHERE id = $1`, [classId, target]),
    ).rejects.toThrow(/priority_open_at must not be later/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. Gate — priority_access_granted
// ════════════════════════════════════════════════════════════════════════════

describe("B. gate", () => {
  it("B1 grants a valid token once priority_open_at has passed", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, { enrollmentOpenAt: hoursFromNow(1) });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    expect(await granted(classId, hashPriorityToken(token))).toBe(true);
  });

  it("B2 refuses a valid token while priority_open_at is still in the future", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(1));
    const classId = await createClass(intakeId, tenantId, { enrollmentOpenAt: hoursFromNow(2) });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    expect(await granted(classId, hashPriorityToken(token))).toBe(false);
  });

  it("B3 refuses an unknown token", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, { enrollmentOpenAt: hoursFromNow(1) });
    // A real, unrelated signup on this intake. Without it, the gate's
    // `JOIN event_interest ei ON ei.intake_id = c.intake_id` matches no rows
    // at all, and EXISTS(...) is false regardless of whether the token
    // comparison is even evaluated — the test would then prove "an intake
    // with no signups grants nothing", not "an unknown token is refused".
    await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const unknownHash = hashPriorityToken(`never-issued-${uniq()}`);
    expect(await granted(classId, unknownHash)).toBe(false);
  });

  it("B4 refuses a revoked token", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, { enrollmentOpenAt: hoursFromNow(1) });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    await sql(`UPDATE event_interest SET revoked_at = now() WHERE token_hash = $1`, [
      hashPriorityToken(token),
    ]);

    expect(await granted(classId, hashPriorityToken(token))).toBe(false);
  });

  it("B5 refuses a token from intake A presented against a class of intake B", async () => {
    const tenantId = await createTenant();
    const intakeA = await createIntake(tenantId, hoursFromNow(-1));
    const intakeB = await createIntake(tenantId, hoursFromNow(-1));
    const classB = await createClass(intakeB, tenantId, { enrollmentOpenAt: hoursFromNow(1) });
    const tokenA = await createInterest(intakeA, tenantId, `${uniq()}@example.test`);

    expect(await granted(classB, hashPriorityToken(tokenA))).toBe(false);
  });

  it("B6 grants a superseded token inside its grace window", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, { enrollmentOpenAt: hoursFromNow(1) });
    await createInterest(intakeId, tenantId, `${uniq()}@example.test`); // current token, unused here

    const oldToken = mintPriorityToken();
    await sql(
      `UPDATE event_interest
         SET superseded_token_hash = $2, superseded_expires_at = $3
       WHERE intake_id = $1`,
      [intakeId, oldToken.tokenHash, hoursFromNow(1)], // grace window still open
    );

    expect(await granted(classId, oldToken.tokenHash)).toBe(true);
  });

  it("B7 refuses a superseded token after its grace window has passed", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, { enrollmentOpenAt: hoursFromNow(1) });
    await createInterest(intakeId, tenantId, `${uniq()}@example.test`); // current token, unused here

    const oldToken = mintPriorityToken();
    await sql(
      `UPDATE event_interest
         SET superseded_token_hash = $2, superseded_expires_at = $3
       WHERE intake_id = $1`,
      [intakeId, oldToken.tokenHash, hoursFromNow(-1)], // grace window already closed
    );

    expect(await granted(classId, oldToken.tokenHash)).toBe(false);
  });

  it("B8 refuses a valid token when priority_open_at is unset", async () => {
    // The default state for any intake collecting signups — its window has
    // never been scheduled. The gate's `i.priority_open_at IS NOT NULL`
    // guard has no other coverage among the cases above, which all set it.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, null);
    const classId = await createClass(intakeId, tenantId, { enrollmentOpenAt: null });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    expect(await granted(classId, hashPriorityToken(token))).toBe(false);
  });

  it("B9 still grants the current token after rotation, with superseded columns populated", async () => {
    // B1 grants a current token on a row whose superseded columns are both
    // NULL. B6/B7 exercise the superseded branch in isolation. Neither
    // covers the shape the schema actually holds after a real rotation:
    // current token live AND superseded token live at the same time — the
    // state a malformed OR in the gate would get wrong.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, { enrollmentOpenAt: hoursFromNow(1) });
    const currentToken = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const oldToken = mintPriorityToken();
    await sql(
      `UPDATE event_interest
         SET superseded_token_hash = $2, superseded_expires_at = $3
       WHERE intake_id = $1`,
      [intakeId, oldToken.tokenHash, hoursFromNow(1)],
    );

    expect(await granted(classId, hashPriorityToken(currentToken))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. The gate through the enrollment RPCs
// ════════════════════════════════════════════════════════════════════════════
//
// A. and B. above prove the trigger and the gate function in isolation. Until
// this section, nothing in the committed suite ever calls submit_enrollment or
// submit_cart_enrollment with a token argument at all — the 202-test baseline
// passed unchanged after 20260827120100_enrollment_rpc_priority_token.sql, so
// everything that migration added was previously verified only by hand in a
// psql session that left no trace.

describe("C. gate through the enrollment RPCs", () => {
  it("C1 submit_enrollment with no token before enrollment_open_at is refused, seat unchanged", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    // A real signup exists so the gate's EXISTS(...) has something to compare
    // against — same rationale as B3.
    await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitEnrollment(classId, null);

    expect(result).toMatchObject({ success: false, error: "ENROLLMENT_NOT_OPEN" });
    expect(await seatRemaining(classId)).toBe(5);
  });

  it("C2 submit_enrollment with a valid token and the window open succeeds, seat drops by quantity", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    // max_tickets_per_person defaults to 1 — raised so quantity 2 does not
    // trip EXCEEDS_MAX_TICKETS before the gate logic is even reached.
    await sql(`UPDATE classes SET max_tickets_per_person = 5 WHERE id = $1`, [classId]);
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitEnrollment(classId, hashPriorityToken(token), 2);

    expect(result).toMatchObject({ success: true, seat_remaining: 3 });
    expect(await seatRemaining(classId)).toBe(3);
  });

  it("C3 a valid token does not survive enrollment_close_at — a head start does not outlive the sale", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    // enrollment_open_at still in the future (so the gate branch is the one
    // that runs), but enrollment_close_at has already passed. Nothing in the
    // schema requires close_at to be after open_at — the window trigger only
    // constrains priority_open_at against enrollment_open_at.
    const [row] = await sql<{ id: string }>(
      `INSERT INTO classes
         (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining,
          enrollment_open_at, enrollment_close_at, status)
       VALUES ($1, $2, $3, 100, 5, 5, $4, $5, 'open') RETURNING id`,
      [tenantId, intakeId, `L${uniq()}`, hoursFromNow(1), hoursFromNow(-1)],
    );
    made.classes.push(row.id);
    const classId = row.id;
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitEnrollment(classId, hashPriorityToken(token));

    expect(result).toMatchObject({ success: false, error: "ENROLLMENT_CLOSED" });
    expect(await seatRemaining(classId)).toBe(5);
  });

  it("C4 a valid token is not a seat guarantee — a full class still refuses", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 0, status: "open",
    });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitEnrollment(classId, hashPriorityToken(token));

    expect(result.success).toBe(false);
    expect(["CLASS_FULL", "NOT_ENOUGH_SEATS"]).toContain(result.error);
    expect(await seatRemaining(classId)).toBe(0);
  });

  it("C5 a multi-tier cart enrolls every tier off one intake-level token", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classA = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const classB = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitCartEnrollment(
      [{ class_id: classA, quantity: 1 }, { class_id: classB, quantity: 1 }],
      tenantId,
      hashPriorityToken(token),
    );

    expect(result).toMatchObject({ success: true });
    expect(await seatRemaining(classA)).toBe(4);
    expect(await seatRemaining(classB)).toBe(4);
  });

  it("C6 a cart mixing the token's intake with a foreign one fails whole, no seat moves anywhere", async () => {
    const tenantId = await createTenant();
    const intakeA = await createIntake(tenantId, hoursFromNow(-1));
    const classA = await createClass(intakeA, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const tokenA = await createInterest(intakeA, tenantId, `${uniq()}@example.test`);

    // Foreign intake, same tenant (required or the cart would fail earlier on
    // CROSS_TENANT and prove nothing about the gate). Also gated — a tier
    // already on public sale would never consult the gate at all, and the
    // whole-call-fails behaviour would then just be an artifact of that tier
    // never needing the token in the first place.
    const intakeB = await createIntake(tenantId, null);
    const classB = await createClass(intakeB, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });

    const result = await submitCartEnrollment(
      [{ class_id: classA, quantity: 1 }, { class_id: classB, quantity: 1 }],
      tenantId,
      hashPriorityToken(tokenA),
    );

    expect(result).toMatchObject({ success: false, error: "ENROLLMENT_NOT_OPEN" });
    // The point of this case: assert seat_remaining on EVERY class in the
    // cart, not just that an error came back. classA's own tier must not have
    // been decremented either, even though its own token check passed.
    expect(await seatRemaining(classA)).toBe(5);
    expect(await seatRemaining(classB)).toBe(5);
  });

  it("C7 two concurrent priority enrollments against the last seat: one wins, seat lands at 0, never negative", async () => {
    // Real concurrency, not a sequential loop: a loop calling the function
    // twice cannot observe the interleaving that makes seat arithmetic race
    // in the first place — see interest-rate-limit.db.test.ts's header for
    // the project's own precedent for this failure mode.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 1, status: "open",
    });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);
    const tokenHash = hashPriorityToken(token);

    const results = await Promise.all(
      [0, 1].map(async () => {
        const client = await pool.connect(); // a SEPARATE connection each
        try {
          const { rows } = await client.query(
            `SELECT public.submit_enrollment($1, $2, $3, $4) AS result`,
            [classId, null, 1, tokenHash],
          );
          const result = rows[0].result as RpcResult;
          if (result.success && result.enrollment_id) {
            made.enrollments.push(String(result.enrollment_id));
          }
          return result;
        } finally {
          client.release();
        }
      }),
    );

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    // Measured, not assumed: with exactly one seat, the winner's own UPDATE
    // sets seat_remaining = 0 AND status = 'full' together, in the same
    // FOR UPDATE-locked transaction the loser blocks on. So the loser's SELECT
    // always observes status = 'full' post-commit and is refused by the
    // `status <> 'open'` check — before it ever reaches the seat-count
    // comparison that would otherwise say CLASS_FULL/NOT_ENOUGH_SEATS. Both
    // are "correctly refused because the seat was already taken"; this one is
    // just which branch a single-seat class deterministically hits first.
    expect(failures[0].error).toBe("CLASS_NOT_OPEN");

    const finalSeats = await seatRemaining(classId);
    expect(finalSeats).toBe(0);
    expect(finalSeats).toBeGreaterThanOrEqual(0); // never negative
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. The redemption transition — currently untested
// ════════════════════════════════════════════════════════════════════════════
//
// Everything below exercises the stamp-and-lock behaviour documented in the
// migration's "The redemption transition, and why it is locked", and in the
// design doc's matching subsection. Nothing before this task ever called the
// RPCs with a token, so none of it has ever run against a committed test.

describe("D. redemption transition", () => {
  it("D1 (case 8) a successful redemption stamps first_used_at and first_converted_enrollment_id, clears the superseded pair", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);
    // Populate the superseded pair beforehand so clearing it is observable —
    // same technique as B6/B9.
    const oldToken = mintPriorityToken();
    await sql(
      `UPDATE event_interest SET superseded_token_hash = $2, superseded_expires_at = $3
       WHERE intake_id = $1`,
      [intakeId, oldToken.tokenHash, hoursFromNow(1)],
    );

    const result = await submitEnrollment(classId, hashPriorityToken(token));
    expect(result.success).toBe(true);

    const [row] = await interestRowsForIntake(intakeId);
    expect(row.first_used_at).not.toBeNull();
    expect(row.first_converted_enrollment_id).toBe(result.enrollment_id);
    expect(row.superseded_token_hash).toBeNull();
    expect(row.superseded_expires_at).toBeNull();
  });

  it("D2 (case 9) after redemption, the now-cleared superseded token is refused — the rotation guarantee", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const currentToken = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);
    const oldToken = mintPriorityToken();
    await sql(
      `UPDATE event_interest SET superseded_token_hash = $2, superseded_expires_at = $3
       WHERE intake_id = $1`,
      [intakeId, oldToken.tokenHash, hoursFromNow(1)], // grace window still open
    );

    // Sanity: the superseded token IS live before redemption.
    expect(await granted(classId, oldToken.tokenHash)).toBe(true);

    const first = await submitEnrollment(classId, hashPriorityToken(currentToken));
    expect(first.success).toBe(true);

    // The rotation guarantee: first use of the CURRENT token retires the
    // superseded one, even though its grace window has not itself expired.
    const second = await submitEnrollment(classId, oldToken.tokenHash);
    expect(second).toMatchObject({ success: false, error: "ENROLLMENT_NOT_OPEN" });
  });

  it("D3 (case 10) a second redemption on the same token leaves both stamps at their original values", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);
    const tokenHash = hashPriorityToken(token);

    const first = await submitEnrollment(classId, tokenHash);
    expect(first.success).toBe(true);

    // now() is transaction-constant, so without backdating, a naive re-stamp
    // (unconditional now()) and the correct COALESCE both leave first_used_at
    // looking "unchanged enough" to pass by accident at real-clock speed.
    // Backdating to a value clearly distinguishable from "now" is what makes
    // this assertion able to fail.
    const backdated = hoursFromNow(-3);
    await sql(`UPDATE event_interest SET first_used_at = $2 WHERE intake_id = $1`, [
      intakeId, backdated,
    ]);

    const second = await submitEnrollment(classId, tokenHash);
    expect(second.success).toBe(true);
    expect(second.enrollment_id).not.toBe(first.enrollment_id);

    const [row] = await interestRowsForIntake(intakeId);
    expect(new Date(row.first_used_at!).getTime()).toBe(new Date(backdated).getTime());
    expect(row.first_converted_enrollment_id).toBe(first.enrollment_id);
    expect(row.first_converted_enrollment_id).not.toBe(second.enrollment_id);
  });

  it("D4 (case 11) a tier already on public sale leaves every event_interest row for that intake untouched", async () => {
    const tenantId = await createTenant();
    // priority_open_at unset — this intake's own signups are irrelevant; the
    // tier below is already publicly open (enrollment_open_at in the past),
    // so the gate is never consulted at all.
    const intakeId = await createIntake(tenantId, null);
    const classId = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(-1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitEnrollment(classId, null);
    expect(result.success).toBe(true);

    const [row] = await interestRowsForIntake(intakeId);
    expect(row.first_used_at).toBeNull();
    expect(row.first_converted_enrollment_id).toBeNull();
    expect(row.superseded_token_hash).toBeNull();
  });

  it("D5 (case 12) a cart over three tiers of one intake stamps exactly one row once, against the cart's own enrollment", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classA = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const classB = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const classC = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitCartEnrollment(
      [
        { class_id: classA, quantity: 1 },
        { class_id: classB, quantity: 1 },
        { class_id: classC, quantity: 1 },
      ],
      tenantId,
      hashPriorityToken(token),
    );
    expect(result.success).toBe(true);

    // The parent cart enrollment: class_id IS NULL, per submit_cart_enrollment
    // Phase 2. first_converted_enrollment_id must point HERE, not at any tier.
    const [cartRow] = await sql<{ class_id: string | null }>(
      `SELECT class_id FROM enrollments WHERE id = $1`,
      [result.enrollment_id],
    );
    expect(cartRow.class_id).toBeNull();

    const rows = await interestRowsForIntake(intakeId);
    expect(rows).toHaveLength(1); // only the one interest row exists for this intake
    expect(rows[0].first_used_at).not.toBeNull();
    expect(rows[0].first_converted_enrollment_id).toBe(result.enrollment_id);
  });

  it("D6 (case 13) a cart mixing a gated tier with an already-open tier of the same intake still stamps exactly once", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const gatedClass = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const openClass = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(-1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);

    const result = await submitCartEnrollment(
      [{ class_id: gatedClass, quantity: 1 }, { class_id: openClass, quantity: 1 }],
      tenantId,
      hashPriorityToken(token),
    );
    expect(result.success).toBe(true);

    const rows = await interestRowsForIntake(intakeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].first_used_at).not.toBeNull();
    expect(rows[0].first_converted_enrollment_id).toBe(result.enrollment_id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E. The revoke race — two connections
// ════════════════════════════════════════════════════════════════════════════
//
// Case 14. priority_access_granted is STABLE and takes no lock, so without the
// FOR UPDATE on the matching event_interest row, an admin's revoke committing
// while an enrollment is in flight would let that enrollment through anyway.
// This is the case the migration's own comment calls out as the actual fix —
// "What closes the race is the FOR UPDATE, not the shape of the predicate" —
// and it is proven mutation-tested below (see the report for the verbatim
// broken-state output), not just asserted to look plausible.

describe("E. the revoke race, two connections", () => {
  it("E1 (case 14) a revoke that commits while an enrollment is in flight is refused, seat unchanged", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));
    const classId = await createClass(intakeId, tenantId, {
      enrollmentOpenAt: hoursFromNow(1), seatTotal: 5, seatRemaining: 5, status: "open",
    });
    const token = await createInterest(intakeId, tenantId, `${uniq()}@example.test`);
    const [{ id: interestId }] = await sql<{ id: string }>(
      `SELECT id FROM event_interest WHERE intake_id = $1`,
      [intakeId],
    );

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();
    // A per-step ceiling: a deadlock or a broken lock ordering fails the test
    // instead of hanging the whole suite.
    await c1.query(`SET statement_timeout = '5s'`);
    await c2.query(`SET statement_timeout = '5s'`);

    try {
      // Session A: revoke, held open — the synchronisation point.
      await c1.query("BEGIN");
      await c1.query(`UPDATE event_interest SET revoked_at = now() WHERE id = $1`, [interestId]);

      // Session B: the enrollment call, issued strictly inside A's open
      // transaction. Whether it BLOCKS is the mechanism under test, not
      // something assumed — raced against a timeout so the assertion below
      // fails (not hangs) if the FOR UPDATE is missing.
      const bPromise = c2
        .query(`SELECT public.submit_enrollment($1, $2, $3, $4) AS result`, [
          classId, null, 1, hashPriorityToken(token),
        ])
        .then((r) => ({ outcome: "completed" as const, result: r.rows[0].result as RpcResult }));

      const raced = await Promise.race([
        bPromise,
        new Promise<{ outcome: "blocked" }>((resolve) =>
          setTimeout(() => resolve({ outcome: "blocked" }), 800),
        ),
      ]);

      expect(
        raced.outcome,
        "B must block on A's uncommitted revoke, held by the FOR UPDATE row lock",
      ).toBe("blocked");

      await c1.query("COMMIT"); // A's revoke commits first
      const b = await bPromise; // now released, re-evaluates under the lock
      if (b.result.success && b.result.enrollment_id) {
        made.enrollments.push(String(b.result.enrollment_id));
      }

      expect(b.result).toMatchObject({ success: false, error: "ENROLLMENT_NOT_OPEN" });
    } finally {
      await c1.end();
      await c2.end();
    }

    expect(await seatRemaining(classId)).toBe(5);
  });
});
