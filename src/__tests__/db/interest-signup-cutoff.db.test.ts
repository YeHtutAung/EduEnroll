import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Pool, Client } from "pg";
import { mintPriorityToken } from "@/lib/interest/token";

// ─── The interest signup cutoff is enforced by the database ────────────────
//
// Covers 20260830120000_interest_signup_cutoff.sql.
//
// This belongs in the DB suite and nowhere else. The rule it tests used to
// live only in src/app/api/public/interest/route.ts, which reads the intake,
// compares the clock against priority_open_at, and only then — after a
// rate-limiter RPC and a lookup — inserts. Every test here writes STRAIGHT to
// the database with no route in the loop, so a green result cannot be a green
// result of the route's check.
//
// S2 is the one that discriminates. It inserts after the window has opened,
// which the route-only implementation had no way to refuse once a request had
// been admitted, and which every other writer of event_interest could do
// freely. S5 and S6 close the two ways a trigger can look right and still
// leave the gap: reading a stale intake, and reading the transaction's clock
// instead of the write's.
//
// S4 is the counterweight. The trigger must NOT fire on UPDATE: rotation is
// an UPDATE, and someone already on the list has to be able to recover a lost
// link during the window. A cutoff that also stopped resend would be a
// regression dressed up as a fix.
//
// Requires the isolated local stack. See setup.ts for the local-only guards.
//
// TIME-MARGIN RULE: fixture timestamps use hoursFromNow(±1) — about an hour of
// margin either side of "now", never a near-instant boundary, for the reasons
// spelled out in priority-window.db.test.ts. S6 is the single deliberate
// exception and carries its own justification.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Fixture tracking ────────────────────────────────────────────────────────
// Ids recorded at creation, never at teardown — same discipline as
// priority-window.db.test.ts and rotate-revocation.db.test.ts.
type Tracked = { tenants: string[]; intakes: string[]; interests: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], interests: [] });

let seq = 0;
const uniq = () => `c${Date.now().toString(36)}${seq++}`;

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

/** priorityOpenAt: an ISO timestamp, or null to leave the window unset. */
async function createIntake(tenantId: string, priorityOpenAt: string | null): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year, priority_open_at)
     VALUES ($1, 'Cutoff test', 2026, $2) RETURNING id`,
    [tenantId, priorityOpenAt],
  );
  made.intakes.push(row.id);
  return row.id;
}

/**
 * The raw INSERT the public signup path performs, with nothing in front of it.
 * Deliberately not routed through registerInterest: the property under test is
 * that the DATABASE refuses this, whoever is asking.
 */
async function insertInterest(
  intakeId: string,
  tenantId: string,
  client?: Client,
): Promise<string> {
  const minted = mintPriorityToken();
  const text = `INSERT INTO event_interest
       (tenant_id, intake_id, name, email, token_hash, token_prefix)
     VALUES ($1, $2, 'Cutoff Test', $3, $4, $5) RETURNING id`;
  const params = [
    tenantId,
    intakeId,
    `${uniq()}@example.com`,
    minted.tokenHash,
    minted.tokenPrefix,
  ];
  const rows = client
    ? (await client.query(text, params)).rows
    : await sql<{ id: string }>(text, params);
  const id = (rows[0] as { id: string }).id;
  made.interests.push(id);
  return id;
}

/** Moves the window without going through the intake editor. */
const setWindow = async (intakeId: string, priorityOpenAt: string | null) =>
  sql(`UPDATE intakes SET priority_open_at = $2 WHERE id = $1`, [intakeId, priorityOpenAt]);

const countInterest = async (intakeId: string): Promise<number> =>
  Number(
    (
      await sql<{ count: string }>(
        `SELECT count(*) AS count FROM event_interest WHERE intake_id = $1`,
        [intakeId],
      )
    )[0].count,
  );

const currentHash = async (interestId: string): Promise<string> =>
  (
    await sql<{ token_hash: string }>(`SELECT token_hash FROM event_interest WHERE id = $1`, [
      interestId,
    ])
  )[0].token_hash;

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1"); // fail fast on a bad DATABASE_URL
});

afterEach(async () => {
  const { tenants, intakes, interests } = made;
  if (interests.length) {
    await sql(`DELETE FROM event_interest WHERE id = ANY($1::uuid[])`, [interests]);
  }
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

// ════════════════════════════════════════════════════════════════════════════

describe("S. event_interest signup cutoff", () => {
  it("S1 admits a signup while the window is still in the future", async () => {
    // The control. Without it, a trigger that refused everything would pass
    // every other test in this file.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(1));

    await insertInterest(intakeId, tenantId);

    expect(await countInterest(intakeId)).toBe(1);
  });

  it("S2 refuses a signup once the window has opened, with no route involved", async () => {
    // THE test for the finding. The route's check cannot help here: this
    // insert never passes through it. Before the trigger, any writer — a
    // request admitted a moment before the window and completing after it, an
    // admin script, a future endpoint — could mint a head start at the exact
    // moment the head start stopped being one.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(-1));

    await expect(insertInterest(intakeId, tenantId)).rejects.toThrow(
      /priority window for intake .* has already opened/,
    );

    // Refused, not merely reported: nothing was written.
    expect(await countInterest(intakeId)).toBe(0);
  });

  it("S3 refuses a signup on an intake with no window scheduled", async () => {
    // A null priority_open_at is not "always open" — the gate requires the
    // column to be set before it honours any token, so a row created here
    // could never grant anything and would sit on the (intake_id, email)
    // unique slot the person's real signup needs later.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, null);

    await expect(insertInterest(intakeId, tenantId)).rejects.toThrow(
      /has no priority window/,
    );

    expect(await countInterest(intakeId)).toBe(0);
  });

  it("S4 still lets an existing row rotate after the window has opened", async () => {
    // The trigger fires on INSERT only. Rotation is an UPDATE, and it is how
    // someone already on the list recovers a lost link — during the window is
    // exactly when they need it. A BEFORE INSERT OR UPDATE trigger would pass
    // S1-S3 and break this.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(1));
    const interestId = await insertInterest(intakeId, tenantId);
    const before = await currentHash(interestId);

    await setWindow(intakeId, hoursFromNow(-1)); // the window is now open

    const minted = mintPriorityToken();
    const [row] = await sql<{ result: string }>(
      `SELECT public.rotate_interest_token($1, $2, $3, $4::interval, $5::interval) AS result`,
      [interestId, minted.tokenHash, minted.tokenPrefix, "24 hours", "0 seconds"],
    );

    expect(row.result).toBe("ROTATED");
    expect(await currentHash(interestId)).not.toBe(before);
  });

  it("S5 re-reads the intake at write time, so a committed window change binds", async () => {
    // A trigger that trusted a value read earlier in the transaction — or a
    // caller's earlier read — would admit this. The window is moved into the
    // past and committed by another connection while the inserting
    // transaction is already open.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(1));

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();

    try {
      await c1.query("BEGIN");
      // Reads the intake as it stands: the window is still an hour away.
      const seen = await c1.query(`SELECT priority_open_at FROM intakes WHERE id = $1`, [
        intakeId,
      ]);
      expect(new Date(seen.rows[0].priority_open_at).getTime()).toBeGreaterThan(Date.now());

      // Another connection opens the window and commits.
      await setWindow(intakeId, hoursFromNow(-1));

      await expect(insertInterest(intakeId, tenantId, c1)).rejects.toThrow(
        /has already opened/,
      );
      await c1.query("ROLLBACK");
    } finally {
      await c1.end();
    }

    expect(await countInterest(intakeId)).toBe(0);
  });

  it("S6 measures the window against the write, not against the transaction's start", async () => {
    // now() is the TRANSACTION's start time. A trigger using it would admit a
    // writer that opened its transaction before the window and inserted after
    // it — the finding's own shape, moved one layer down. clock_timestamp() is
    // read at the instant of the write, which is what makes the check and the
    // write one operation.
    //
    // The one sub-second fixture in this file, and it does not race: the
    // window is placed 200ms after the transaction started and the insert is
    // held back by a 500ms sleep. The assertion is that the insert is REFUSED,
    // and any scheduling delay pushes clock_timestamp() further past the
    // boundary — a slow machine makes this test more certain, never flakier.
    // The transaction's own now() is frozen at BEGIN and cannot drift.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId, hoursFromNow(1));

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();

    try {
      await c1.query("BEGIN");
      const [{ t0 }] = (await c1.query(`SELECT now() AS t0`)).rows as [{ t0: Date }];

      // Opens 200ms after this transaction began — still in the future by the
      // transaction's clock, already in the past by the wall clock below.
      await setWindow(intakeId, new Date(t0.getTime() + 200).toISOString());
      await c1.query(`SELECT pg_sleep(0.5)`);

      await expect(insertInterest(intakeId, tenantId, c1)).rejects.toThrow(
        /has already opened/,
      );
      await c1.query("ROLLBACK");
    } finally {
      await c1.end();
    }

    expect(await countInterest(intakeId)).toBe(0);
  });
});
