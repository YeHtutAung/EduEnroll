import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Pool } from "pg";
import { randomBytes } from "crypto";

// ─── consume_interest_signup_slot: rate-limit atomicity ─────────────────────
//
// This is the one test in the suite whose SEQUENTIAL version passes against a
// completely broken implementation. consume_interest_signup_slot takes a
// transaction-scoped advisory lock, then counts, then inserts. Written
// naively — count in the application, then insert — concurrent callers each
// observe capacity and all proceed, blowing straight through the limit. A
// loop calling the function ten times is not concurrent and would not catch
// that.
//
// So every case below that matters for atomicity issues its calls from
// SEPARATE pg connections via Promise.all, never sequentially through the
// shared `sql` helper. This project has already shipped exactly this failure
// mode once: the limiter called pg_advisory_xact_lock(bigint, bigint), an
// overload that does not exist. It compiled, applied, and passed a 181-test
// suite, because nothing invoked it concurrently.
//
// Requires the isolated local stack. See setup.ts for the local-only guards.

// max set explicitly and comfortably above the largest ATTEMPTS count below.
// The default pg Pool max is 10 — with ATTEMPTS=12 that would queue two
// connections behind the others instead of letting all twelve calls actually
// overlap, silently turning the atomicity test back into a sequential one.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Fixture tracking ────────────────────────────────────────────────────────
// Ids recorded at creation, never at teardown — see seat-restoration.db.test.ts
// for why. interest_signup_attempts rows cascade-delete with their intake (FK
// ON DELETE CASCADE), and every attempt inserted below is always scoped to a
// tracked intake, so deleting tracked intakes is sufficient cleanup.
type Tracked = { tenants: string[]; intakes: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [] });

let seq = 0;
const uniq = () => `rl${Date.now().toString(36)}${seq++}`;

/** 64 lowercase hex chars — matches interest_signup_attempts_ip_format. */
const ipHash = () => randomBytes(32).toString("hex");

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

async function createIntake(tenantId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1, 'Test intake', 2026) RETURNING id`,
    [tenantId],
  );
  made.intakes.push(row.id);
  return row.id;
}

/** One tenant + one intake — the shape almost every case below needs. */
async function scenario(): Promise<{ tenantId: string; intakeId: string }> {
  const tenantId = await createTenant();
  const intakeId = await createIntake(tenantId);
  return { tenantId, intakeId };
}

/** Ages an attempt row directly: the table has no updated_at to backdate. */
async function insertAgedAttempt(intakeId: string, ip: string, minutesAgo: number) {
  await sql(
    `INSERT INTO interest_signup_attempts (intake_id, ip_hash, created_at)
     VALUES ($1, $2, now() - ($3 || ' minutes')::interval)`,
    [intakeId, ip, String(minutesAgo)],
  );
}

// ── Readers ─────────────────────────────────────────────────────────────────

/** Sequential convenience call through the shared pool — NOT for concurrency cases. */
async function consume(
  intakeId: string,
  ip: string,
  opts: { perIntakeLimit?: number; globalLimit?: number; window?: string } = {},
): Promise<boolean> {
  const { perIntakeLimit = 1000, globalLimit = 1000, window = "1 hour" } = opts;
  const [row] = await sql<{ ok: boolean }>(
    `SELECT public.consume_interest_signup_slot($1, $2, $3, $4, $5) AS ok`,
    [intakeId, ip, perIntakeLimit, globalLimit, window],
  );
  return row.ok;
}

const attemptCount = async (ip: string) =>
  Number(
    (await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM interest_signup_attempts WHERE ip_hash = $1`,
      [ip],
    ))[0].n,
  );

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1"); // fail fast on a bad DATABASE_URL
});

afterEach(async () => {
  // FK-safe order. Runs even when the test failed, hence the recorded ids.
  const { tenants, intakes } = made;
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

// ════════════════════════════════════════════════════════════════════════════
// A. Atomicity under real concurrency — the reason this file exists
// ════════════════════════════════════════════════════════════════════════════

describe("A. atomicity under concurrency", () => {
  it("admits exactly the limit when requests arrive concurrently", async () => {
    const { intakeId } = await scenario();
    const ip = ipHash();
    const LIMIT = 3;
    const ATTEMPTS = 12;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, async () => {
        const client = await pool.connect(); // a SEPARATE connection each
        try {
          const { rows } = await client.query(
            `SELECT public.consume_interest_signup_slot($1, $2, $3, $4, $5) AS ok`,
            [intakeId, ip, LIMIT, 100, "1 hour"],
          );
          return rows[0].ok as boolean;
        } finally {
          client.release();
        }
      }),
    );

    expect(results.filter(Boolean)).toHaveLength(LIMIT);
  });

  it("A2 the same holds against the global limit, not just the per-intake one", async () => {
    // A1 pins LIMIT via p_per_intake_limit with a loose global limit. This
    // pins it via p_global_limit with a loose per-intake limit, so a fix that
    // only serializes one of the two counts cannot hide behind the other.
    const { intakeId } = await scenario();
    const ip = ipHash();
    const LIMIT = 3;
    const ATTEMPTS = 12;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, async () => {
        const client = await pool.connect();
        try {
          const { rows } = await client.query(
            `SELECT public.consume_interest_signup_slot($1, $2, $3, $4, $5) AS ok`,
            [intakeId, ip, 100, LIMIT, "1 hour"],
          );
          return rows[0].ok as boolean;
        } finally {
          client.release();
        }
      }),
    );

    expect(results.filter(Boolean)).toHaveLength(LIMIT);
  });

  it("A3 the global limit still serializes when the same address hits two different intakes at once", async () => {
    // A1 and A2 give every concurrent call the same single intake AND the
    // same single address, so a lock keyed on EITHER value serializes them
    // identically — neither case can tell "locked by address" apart from
    // "locked by intake". This one pins the difference: one address racing
    // across TWO intakes, checked against the GLOBAL count (which is meant
    // to span intakes). A lock mistakenly keyed on intake_id would let calls
    // against different intakes run unserialized against each other, so this
    // must go red under that mutant while A1/A2 stay green.
    const tenantId = await createTenant();
    const intakeA = await createIntake(tenantId);
    const intakeB = await createIntake(tenantId);
    const ip = ipHash();
    const LIMIT = 3;
    const ATTEMPTS = 12;
    // High enough that the per-intake count (max 6 calls per intake here)
    // can never bind — only the global count can be why this refuses.
    const PER_INTAKE_LIMIT = 1000;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, async (_, i) => {
        const intakeId = i % 2 === 0 ? intakeA : intakeB;
        const client = await pool.connect(); // a SEPARATE connection each
        try {
          const { rows } = await client.query(
            `SELECT public.consume_interest_signup_slot($1, $2, $3, $4, $5) AS ok`,
            [intakeId, ip, PER_INTAKE_LIMIT, LIMIT, "1 hour"],
          );
          return rows[0].ok as boolean;
        } finally {
          client.release();
        }
      }),
    );

    expect(results.filter(Boolean)).toHaveLength(LIMIT);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. Per-intake and global limits throttle independently
// ════════════════════════════════════════════════════════════════════════════

describe("B. per-intake vs global limit", () => {
  it("B1 exhausting intake A's per-intake limit still allows a first attempt on intake B", async () => {
    const tenantId = await createTenant();
    const intakeA = await createIntake(tenantId);
    const intakeB = await createIntake(tenantId);
    const ip = ipHash();

    expect(await consume(intakeA, ip, { perIntakeLimit: 1, globalLimit: 100 })).toBe(true);
    expect(await consume(intakeA, ip, { perIntakeLimit: 1, globalLimit: 100 })).toBe(false);

    // Same address, different intake, well under the shared global limit.
    expect(await consume(intakeB, ip, { perIntakeLimit: 1, globalLimit: 100 })).toBe(true);
  });

  it("B2 the global limit refuses a request even when its own intake is well under limit", async () => {
    const tenantId = await createTenant();
    const intakeA = await createIntake(tenantId);
    const intakeB = await createIntake(tenantId);
    const ip = ipHash();

    // Exhausts the GLOBAL limit of 1 against intake A, whose per-intake
    // limit (100) is nowhere near reached.
    expect(await consume(intakeA, ip, { perIntakeLimit: 100, globalLimit: 1 })).toBe(true);

    // intake B is untouched and its own per-intake limit is generous — only
    // the shared global count can be the reason this refuses.
    expect(await consume(intakeB, ip, { perIntakeLimit: 100, globalLimit: 1 })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Window — rows outside p_window are not counted
// ════════════════════════════════════════════════════════════════════════════

describe("C. window", () => {
  it("C1 an attempt older than the window does not consume a slot", async () => {
    const { intakeId } = await scenario();
    const ip = ipHash();

    // Well outside a 1-hour window, comfortably past it either direction.
    await insertAgedAttempt(intakeId, ip, 120);

    // limit 1: if the aged row counted, this would be refused.
    expect(await consume(intakeId, ip, { perIntakeLimit: 1, globalLimit: 1, window: "1 hour" })).toBe(true);
  });

  it("C2 an attempt inside the window does consume a slot", async () => {
    // Companion to C1: proves the window predicate discriminates, rather than
    // the function simply never refusing anything.
    const { intakeId } = await scenario();
    const ip = ipHash();

    expect(await consume(intakeId, ip, { perIntakeLimit: 1, globalLimit: 1, window: "1 hour" })).toBe(true);
    expect(await consume(intakeId, ip, { perIntakeLimit: 1, globalLimit: 1, window: "1 hour" })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. Prune is scoped to the calling address only
// ════════════════════════════════════════════════════════════════════════════

describe("D. scoped prune", () => {
  it("D1 pruning for one address leaves another address's expired rows untouched", async () => {
    // The prune was deliberately scoped per-address (see the migration's
    // comment on the DELETE inside consume_interest_signup_slot). A
    // regression to a global "DELETE ... WHERE created_at < ..." would look
    // harmless and pass every other case here, since every other case only
    // ever uses one address at a time.
    const { intakeId } = await scenario();
    const ipA = ipHash();
    const ipB = ipHash();

    await insertAgedAttempt(intakeId, ipA, 120);
    await insertAgedAttempt(intakeId, ipB, 120);

    // Call for ipA only, with a 1-hour window — its own aged row is pruned
    // and replaced by the fresh row this call inserts.
    expect(await consume(intakeId, ipA, { window: "1 hour" })).toBe(true);

    expect(await attemptCount(ipA)).toBe(1); // old row pruned, new row inserted
    expect(await attemptCount(ipB)).toBe(1); // ipB's expired row must survive
  });
});
