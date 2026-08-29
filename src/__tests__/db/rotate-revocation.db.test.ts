import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Pool, Client } from "pg";
import { mintPriorityToken } from "@/lib/interest/token";

// ─── rotate_interest_token re-checks revocation under the row lock ──────────
//
// Covers 20260829120000_rotate_checks_revocation.sql. This belongs in the DB
// suite and nowhere else: the property under test is that the revocation check
// happens INSIDE the same transaction that holds SELECT ... FOR UPDATE, and no
// amount of mocking in the route tests can observe that. The application-side
// pre-check in the invite route is a stale read by construction — an admin can
// revoke between the caller's SELECT and the rotation — so if this file is
// green only because the route also checks, it is testing nothing.
//
// R3 is the one that discriminates. R1 and R2 pass against a naive
// implementation that checks revoked_at outside a lock; only a concurrent
// revoke that commits while the rotation is queued behind it proves the check
// is evaluated under the lock rather than before it.
//
// Requires the isolated local stack. See setup.ts for the local-only guards.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

// ── Fixture tracking ────────────────────────────────────────────────────────
// Ids recorded at creation, never at teardown — same discipline as
// priority-window.db.test.ts. event_interest cascades with its intake, but is
// tracked and deleted explicitly anyway so a test that fails midway does not
// depend on an ordering it never reached.
type Tracked = { tenants: string[]; intakes: string[]; interests: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], interests: [] });

let seq = 0;
const uniq = () => `r${Date.now().toString(36)}${seq++}`;

const GRACE = "24 hours";
/** The admin bypass the invite and resend routes use. */
const NO_COOLDOWN = "0 seconds";

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
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1, 'Rotate test', 2026) RETURNING id`,
    [tenantId],
  );
  made.intakes.push(row.id);
  return row.id;
}

interface Interest {
  id: string;
  tokenHash: string;
  tokenPrefix: string;
}

async function createInterest(
  intakeId: string,
  tenantId: string,
  revoked = false,
): Promise<Interest> {
  const minted = mintPriorityToken();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO event_interest
       (tenant_id, intake_id, name, email, token_hash, token_prefix, revoked_at)
     VALUES ($1, $2, 'Rotate Test', $3, $4, $5, $6) RETURNING id`,
    [
      tenantId,
      intakeId,
      `${uniq()}@example.com`,
      minted.tokenHash,
      minted.tokenPrefix,
      revoked ? new Date().toISOString() : null,
    ],
  );
  made.interests.push(row.id);
  return { id: row.id, tokenHash: minted.tokenHash, tokenPrefix: minted.tokenPrefix };
}

// ── Callers and readers ─────────────────────────────────────────────────────

const rotate = async (interestId: string, cooldown = NO_COOLDOWN): Promise<string> => {
  const minted = mintPriorityToken();
  const [row] = await sql<{ result: string }>(
    `SELECT public.rotate_interest_token($1, $2, $3, $4::interval, $5::interval) AS result`,
    [interestId, minted.tokenHash, minted.tokenPrefix, GRACE, cooldown],
  );
  return row.result;
};

const currentHash = async (interestId: string): Promise<string> =>
  (
    await sql<{ token_hash: string }>(`SELECT token_hash FROM event_interest WHERE id = $1`, [
      interestId,
    ])
  )[0].token_hash;

const supersededHash = async (interestId: string): Promise<string | null> =>
  (
    await sql<{ superseded_token_hash: string | null }>(
      `SELECT superseded_token_hash FROM event_interest WHERE id = $1`,
      [interestId],
    )
  )[0].superseded_token_hash;

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

describe("R. rotate_interest_token and revocation", () => {
  it("R1 refuses to rotate a revoked row, and writes nothing", async () => {
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const interest = await createInterest(intakeId, tenantId, true);

    expect(await rotate(interest.id)).toBe("NOT_FOUND");

    // Not merely refused — untouched. A rotation that reported failure while
    // still moving the token would strand the recipient's link either way.
    expect(await currentHash(interest.id)).toBe(interest.tokenHash);
    expect(await supersededHash(interest.id)).toBeNull();
  });

  it("R2 still rotates a live row", async () => {
    // The control. Without it, a function that returned NOT_FOUND for
    // everything would pass R1.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const interest = await createInterest(intakeId, tenantId, false);

    expect(await rotate(interest.id)).toBe("ROTATED");
    expect(await currentHash(interest.id)).not.toBe(interest.tokenHash);
    expect(await supersededHash(interest.id)).toBe(interest.tokenHash);
  });

  it("R3 a revoke committed while a rotation is queued makes that rotation refuse", async () => {
    // THE test. A rotation that read revoked_at before taking the lock — or
    // that trusted a caller's earlier read — would rotate here, because the row
    // was live at the moment the rotation began.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const interest = await createInterest(intakeId, tenantId, false);

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();

    try {
      // A: revoke, holding the row lock, uncommitted.
      await c1.query("BEGIN");
      await c1.query(`UPDATE event_interest SET revoked_at = now() WHERE id = $1`, [interest.id]);

      // B: rotate. Blocks on A's lock rather than reading around it.
      const minted = mintPriorityToken();
      const bPromise = c2
        .query(
          `SELECT public.rotate_interest_token($1, $2, $3, $4::interval, $5::interval) AS result`,
          [interest.id, minted.tokenHash, minted.tokenPrefix, GRACE, NO_COOLDOWN],
        )
        .then((r) => ({ outcome: "completed" as const, result: r.rows[0].result as string }));

      const raced = await Promise.race([
        bPromise,
        new Promise<{ outcome: "blocked" }>((resolve) =>
          setTimeout(() => resolve({ outcome: "blocked" }), 800),
        ),
      ]);

      expect(
        raced.outcome,
        "B must still be queued when A commits — otherwise this is not a race",
      ).toBe("blocked");

      await c1.query("COMMIT"); // the revoke lands first

      const b = await bPromise; // released, and must re-evaluate under the lock
      expect(b.result).toBe("NOT_FOUND");
    } finally {
      await c1.end();
      await c2.end();
    }

    // The credential the recipient holds is untouched, and no grace slot was
    // burned on a link the gate would have refused.
    expect(await currentHash(interest.id)).toBe(interest.tokenHash);
    expect(await supersededHash(interest.id)).toBeNull();
  });

  it("R4 revocation is checked before the cooldown, not after", async () => {
    // Ordering matters for the caller's sake: a revoked row inside its cooldown
    // must report NOT_FOUND, not COOLDOWN. COOLDOWN reads as "try again in
    // fifteen minutes" and would send an admin back to a record that will never
    // rotate again.
    const tenantId = await createTenant();
    const intakeId = await createIntake(tenantId);
    const interest = await createInterest(intakeId, tenantId, false);

    // Put the row firmly inside a cooldown.
    await sql(`UPDATE event_interest SET last_link_attempt_at = now() WHERE id = $1`, [
      interest.id,
    ]);
    expect(await rotate(interest.id, "15 minutes")).toBe("COOLDOWN");

    await sql(`UPDATE event_interest SET revoked_at = now() WHERE id = $1`, [interest.id]);
    expect(await rotate(interest.id, "15 minutes")).toBe("NOT_FOUND");
  });
});
