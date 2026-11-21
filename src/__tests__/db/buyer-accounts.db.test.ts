import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { randomUUID } from "crypto";

// ─── Buyer accounts: profile claims, rate limits, email sync ─────────────────
// Every new object is service-role only. These tests call the RPCs as the
// superuser connection (the server calls them as service_role) and check that
// an authenticated session can neither run them nor read the tables.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const users: string[] = [];
const rateKeys: string[] = [];

async function newUser(): Promise<string> {
  const id = randomUUID();
  await sql(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, `buyer-${id}@example.test`]);
  users.push(id);
  return id;
}

const claim = async (userId: string) =>
  (await sql<{ r: string | null }>(`SELECT public.claim_buyer_profile($1) AS r`, [userId]))[0].r;

const create = async (userId: string, token: string, email: string) =>
  (
    await sql<{ r: string }>(`SELECT public.create_buyer_profile($1, $2, $3) AS r`, [
      userId,
      token,
      email,
    ])
  )[0].r;

const claimRows = async (userId: string) =>
  sql<{ token: string }>(`SELECT token FROM public.buyer_profile_claims WHERE user_id = $1`, [userId]);

const profile = async (userId: string) =>
  (
    await sql<{ email: string; updated_at: Date }>(
      `SELECT email, updated_at FROM public.buyer_profiles WHERE id = $1`,
      [userId],
    )
  )[0];

afterAll(async () => {
  // Profiles and claims go with their auth user (ON DELETE CASCADE).
  if (users.length) await sql(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [users]);
  if (rateKeys.length) await sql(`DELETE FROM public.mobile_rate_limits WHERE key = ANY($1)`, [rateKeys]);
  await pool.end();
});

describe("claim_buyer_profile", () => {
  it("returns a uuid for a fresh user, then NULL while that claim is fresh", async () => {
    const u = await newUser();
    expect(await claim(u)).toMatch(UUID);
    expect(await claim(u)).toBeNull();
  });

  it("takes over a stale claim with a new token; the old token's create is 'lost'", async () => {
    const u = await newUser();
    const first = (await claim(u))!;
    await sql(
      `UPDATE public.buyer_profile_claims SET claimed_at = now() - interval '31 seconds' WHERE user_id = $1`,
      [u],
    );
    const second = (await claim(u))!;
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);

    expect(await create(u, first, `buyer-${u}@example.test`)).toBe("lost");
    expect(await profile(u)).toBeUndefined();
    // The new holder's claim is untouched.
    expect((await claimRows(u)).map((r) => r.token)).toEqual([second]);
  });

  it("returns 'exists' and leaves no claim row when a profile is already there", async () => {
    const u = await newUser();
    const token = (await claim(u))!;
    expect(await create(u, token, `buyer-${u}@example.test`)).toBe("created");

    expect(await claim(u)).toBe("exists");
    expect(await claimRows(u)).toHaveLength(0);
  });
});

describe("create_buyer_profile", () => {
  it("with the held token: 'created', email lower-cased, no claim row left", async () => {
    const u = await newUser();
    const token = (await claim(u))!;
    expect(await create(u, token, `Buyer-${u}@Example.TEST`)).toBe("created");
    expect((await profile(u)).email).toBe(`buyer-${u}@example.test`);
    expect(await claimRows(u)).toHaveLength(0);
  });

  it("returns 'existing' when the row is already there for this user", async () => {
    const u = await newUser();
    const t1 = (await claim(u))!;
    expect(await create(u, t1, `buyer-${u}@example.test`)).toBe("created");
    // A claim inserted by hand, as if taken just before the profile committed.
    const t2 = randomUUID();
    await sql(
      `INSERT INTO public.buyer_profile_claims (user_id, token, claimed_at) VALUES ($1, $2, now())`,
      [u, t2],
    );
    expect(await create(u, t2, `buyer-${u}@example.test`)).toBe("existing");
    expect(await claimRows(u)).toHaveLength(0);
  });

  it("raises unique_violation for another user's email instead of 'existing'", async () => {
    const a = await newUser();
    const b = await newUser();
    const email = `shared-${a}@example.test`;
    expect(await create(a, (await claim(a))!, email)).toBe("created");

    const tokenB = (await claim(b))!;
    await expect(create(b, tokenB, email.toUpperCase())).rejects.toMatchObject({ code: "23505" });
    expect(await profile(b)).toBeUndefined();
    // The claim delete rolled back with the raise; the auth.users cascade cleans it up.
    expect((await claimRows(b)).map((r) => r.token)).toEqual([tokenB]);
  });
});

describe("buyer_profile_claim_held and release_buyer_profile_claim", () => {
  it("only the caller's own token counts or is released", async () => {
    const u = await newUser();
    const token = (await claim(u))!;
    const held = async (t: string) =>
      (await sql<{ r: boolean }>(`SELECT public.buyer_profile_claim_held($1, $2) AS r`, [u, t]))[0].r;

    expect(await held(token)).toBe(true);
    expect(await held(randomUUID())).toBe(false);

    await sql(`SELECT public.release_buyer_profile_claim($1, $2)`, [u, randomUUID()]);
    expect(await claimRows(u)).toHaveLength(1);

    await sql(`SELECT public.release_buyer_profile_claim($1, $2)`, [u, token]);
    expect(await claimRows(u)).toHaveLength(0);
    expect(await held(token)).toBe(false);
  });
});

describe("consume_rate_limit", () => {
  it("allows up to the limit in a window, then refuses", async () => {
    const key = randomUUID();
    rateKeys.push(key);
    const consume = async () =>
      (await sql<{ r: boolean }>(`SELECT public.consume_rate_limit($1, 3600, 2) AS r`, [key]))[0].r;
    expect(await consume()).toBe(true);
    expect(await consume()).toBe(true);
    expect(await consume()).toBe(false);
  });

  it.each([
    ["a window of 0", 0, 2],
    ["a window longer than a day (604800 s)", 604800, 1],
    ["a NULL limit", 3600, null],
  ])("raises 22023 for %s", async (_label, windowSeconds, limit) => {
    const key = randomUUID();
    rateKeys.push(key);
    await expect(
      sql(`SELECT public.consume_rate_limit($1, $2, $3)`, [key, windowSeconds, limit]),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("sweeps old windows of other keys, not only the caller's", async () => {
    const oldKey = randomUUID();
    const freshKey = randomUUID();
    rateKeys.push(oldKey, freshKey);
    await sql(
      `INSERT INTO public.mobile_rate_limits (key, window_start, count) VALUES ($1, now() - interval '3 days', 1)`,
      [oldKey],
    );
    await sql(`SELECT public.consume_rate_limit($1, 3600, 2)`, [freshKey]);
    const left = await sql(`SELECT 1 FROM public.mobile_rate_limits WHERE key = $1`, [oldKey]);
    expect(left).toHaveLength(0);
  });
});

describe("profile email follows the auth email", () => {
  it("an email change is copied lower-cased; other updates leave the profile alone", async () => {
    const u = await newUser();
    expect(await create(u, (await claim(u))!, `buyer-${u}@example.test`)).toBe("created");

    const before = await profile(u);
    await sql(`UPDATE auth.users SET raw_user_meta_data = '{"probe": 1}'::jsonb WHERE id = $1`, [u]);
    const untouched = await profile(u);
    expect(untouched.email).toBe(before.email);
    expect(untouched.updated_at.getTime()).toBe(before.updated_at.getTime());

    // Touching the email column without changing it doesn't fire the sync.
    await sql(`UPDATE auth.users SET email = email WHERE id = $1`, [u]);
    expect((await profile(u)).updated_at.getTime()).toBe(before.updated_at.getTime());

    const newEmail = `New-${u}@Example.test`;
    await sql(`UPDATE auth.users SET email = $2 WHERE id = $1`, [u, newEmail]);
    const changed = await profile(u);
    expect(changed.email).toBe(newEmail.toLowerCase());

    // A NULL auth email succeeds and leaves the profile's email in place.
    await sql(`UPDATE auth.users SET email = NULL WHERE id = $1`, [u]);
    const afterNull = await profile(u);
    expect(afterNull.email).toBe(newEmail.toLowerCase());
    expect(afterNull.updated_at.getTime()).toBe(changed.updated_at.getTime());
  });
});

describe("concurrent claim while a create is in flight", () => {
  it("a claim that waits on an uncommitted create resolves to 'exists'", async () => {
    const u = await newUser();
    const token = (await claim(u))!;

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query("BEGIN");
      const created = await c1.query(`SELECT public.create_buyer_profile($1, $2, $3) AS r`, [
        u,
        token,
        `buyer-${u}@example.test`,
      ]);
      expect(created.rows[0].r).toBe("created");

      const c2Pid = (await c2.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      // Not awaited: blocks on client 1's lock on the claim row.
      const pending = c2.query(`SELECT public.claim_buyer_profile($1) AS r`, [u]);
      // If an assertion below fails first, its error stays the one reported,
      // not an unhandled rejection from this query. The await below still sees it.
      pending.catch(() => {});
      // Commit only once client 2 is actually waiting on a lock, so the test
      // exercises the race rather than two calls in sequence.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [row] = await sql<{ w: string | null }>(
          `SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1`,
          [c2Pid],
        );
        waiting = row?.w === "Lock";
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting).toBe(true);
      await c1.query("COMMIT");

      expect((await pending).rows[0].r).toBe("exists");
      expect(await claimRows(u)).toHaveLength(0);
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c1.end();
      await c2.end();
    }
  });
});

describe("authenticated sessions get nothing", () => {
  let userId = "";
  beforeAll(async () => {
    // Make sure each table has a row this session could see if RLS let it:
    // its own profile, its own claim (another user's, since a profile removes
    // the claim), and a rate-limit window.
    userId = await newUser();
    expect(await create(userId, (await claim(userId))!, `buyer-${userId}@example.test`)).toBe("created");
    await claim(await newUser());
    const key = randomUUID();
    rateKeys.push(key);
    await sql(`SELECT public.consume_rate_limit($1, 3600, 2)`, [key]);
  });

  async function runAs(text: string, params: unknown[] = []) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: "authenticated", amr: [{ method: "otp", timestamp: 1 }] }),
      ]);
      const res = await client.query(text, params);
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  }

  it.each([
    ["claim_buyer_profile", `SELECT public.claim_buyer_profile($1)`, () => [userId]],
    ["consume_rate_limit", `SELECT public.consume_rate_limit($1, 3600, 2)`, () => [randomUUID()]],
    [
      "create_buyer_profile",
      `SELECT public.create_buyer_profile($1, $2, 'x@example.test')`,
      () => [userId, randomUUID()],
    ],
    ["buyer_profile_claim_held", `SELECT public.buyer_profile_claim_held($1, $2)`, () => [userId, randomUUID()]],
    ["release_buyer_profile_claim", `SELECT public.release_buyer_profile_claim($1, $2)`, () => [userId, randomUUID()]],
  ])("cannot run %s (42501)", async (_name, text, params) => {
    await expect(runAs(text, params())).rejects.toMatchObject({ code: "42501" });
  });

  // Locally setup.ts re-grants table DML to authenticated, so RLS (no
  // policies) is what refuses here. The REVOKE itself is proven on the dev
  // database, not locally.
  it.each(["buyer_profiles", "buyer_profile_claims", "mobile_rate_limits"])(
    "sees zero rows of %s",
    async (table) => {
      const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
      expect(n).toBeGreaterThan(0);
      expect((await runAs(`SELECT * FROM public.${table}`)).rowCount).toBe(0);
    },
  );

  it.each([
    ["buyer_profiles", `INSERT INTO public.buyer_profiles (id, email) VALUES ($1, 'x@example.test')`, () => [userId]],
    [
      "buyer_profile_claims",
      `INSERT INTO public.buyer_profile_claims (user_id, token, claimed_at) VALUES ($1, gen_random_uuid(), now())`,
      () => [userId],
    ],
    [
      "mobile_rate_limits",
      `INSERT INTO public.mobile_rate_limits (key, window_start, count) VALUES ($1, now(), 0)`,
      () => [randomUUID()],
    ],
  ])("cannot insert into %s", async (_table, text, params) => {
    await expect(runAs(text, params())).rejects.toThrow(/new row violates row-level security policy/);
  });
});
