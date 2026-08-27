import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Pool } from "pg";
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
};
let made: Tracked;

const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], interests: [] });

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
  opts: { enrollmentOpenAt?: string | null; seatTotal?: number; seatRemaining?: number } = {},
): Promise<string> {
  const { enrollmentOpenAt = null, seatTotal = 10, seatRemaining = 10 } = opts;
  // (intake_id, level) is UNIQUE — level generated so two classes in one
  // intake never collide, same as seat-restoration.db.test.ts.
  const [row] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining, enrollment_open_at)
     VALUES ($1, $2, $6, 100, $3, $4, $5) RETURNING id`,
    [tenantId, intakeId, seatTotal, seatRemaining, enrollmentOpenAt, `L${uniq()}`],
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

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1"); // fail fast on a bad DATABASE_URL
});

afterEach(async () => {
  // FK-safe order. Runs even when the test failed, hence the recorded ids.
  const { tenants, intakes, classes, interests } = made;
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
