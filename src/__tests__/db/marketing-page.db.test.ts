import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { Pool, Client } from "pg";

// ─── Marketing versions, against the REAL database ───────────────────────────
// Locks, partial unique indexes and ACLs don't exist in a mock.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

const CONTENT = JSON.stringify({ marker: "test" });
const TABLE = "public.marketing_page_versions";
const FUNCTIONS = [
  "public.publish_marketing_draft(integer,uuid)",
  "public.create_marketing_draft(uuid,jsonb,uuid)",
];

const create = (base: string | null) =>
  sql<{ id: string }>(
    `SELECT public.create_marketing_draft($1::uuid, $2::jsonb, NULL::uuid) AS id`,
    [base, CONTENT],
  );
const publish = (rev: number) =>
  sql<{ id: string }>(`SELECT public.publish_marketing_draft($1, NULL::uuid) AS id`, [rev]);
const rows = () => sql<{ id: string; status: string; revision: number }>(`SELECT id, status, revision FROM ${TABLE}`);

async function publishedId(): Promise<string> {
  const [d] = await create(null);
  await publish(1);
  return d.id;
}

describe("marketing_page_versions", () => {
  beforeAll(async () => {
    await sql(`DELETE FROM ${TABLE}`);
  });
  afterEach(async () => {
    await sql(`DELETE FROM ${TABLE}`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("first save creates a draft at revision 1", async () => {
    await create(null);
    expect(await rows()).toMatchObject([{ status: "draft", revision: 1 }]);
  });

  it("rejects a second draft", async () => {
    await create(null);
    await expect(create(null)).rejects.toThrow(/marketing_draft_stale/);
  });

  it("gives exactly one winner to concurrent first saves", async () => {
    const results = await Promise.allSettled([create(null), create(null), create(null)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("the partial indexes allow one draft and one published row", async () => {
    await create(null);
    await expect(
      sql(`INSERT INTO ${TABLE} (status, content) VALUES ('draft', $1::jsonb)`, [CONTENT]),
    ).rejects.toThrow(/duplicate key/);
    await publish(1);
    await expect(
      sql(`INSERT INTO ${TABLE} (status, content) VALUES ('published', $1::jsonb)`, [CONTENT]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("publish archives the old row and promotes the draft", async () => {
    const first = await publishedId();
    const [second] = await create(first);
    await publish(1);
    const all = await rows();
    expect(all.find((r) => r.id === first)?.status).toBe("archived");
    expect(all.find((r) => r.id === second.id)?.status).toBe("published");
    expect(all).toHaveLength(2);
  });

  it("publish rejects a stale revision and changes nothing", async () => {
    await create(null);
    await expect(publish(2)).rejects.toThrow(/marketing_draft_stale/);
    expect(await rows()).toMatchObject([{ status: "draft", revision: 1 }]);
  });

  it("publish rejects a missing draft", async () => {
    await expect(publish(1)).rejects.toThrow(/marketing_draft_stale/);
  });

  it("a stale first save after a publish is rejected", async () => {
    const first = await publishedId();
    const [d] = await create(first);
    await publish(1);
    expect(d.id).toBeTruthy();
    // This editor loaded while `first` was published.
    await expect(create(first)).rejects.toThrow(/marketing_draft_stale/);
    // An editor who never saw any published row is stale too.
    await expect(create(null)).rejects.toThrow(/marketing_draft_stale/);
  });

  it("a first save racing a publish waits, then fails as stale", async () => {
    const first = await publishedId();
    await create(first);
    const a = new Client({ connectionString: process.env.DATABASE_URL });
    await a.connect();
    try {
      await a.query("BEGIN");
      await a.query(`SELECT public.publish_marketing_draft(1, NULL::uuid)`);
      const racing = create(first);
      await new Promise((r) => setTimeout(r, 300));
      await a.query("COMMIT");
      await expect(racing).rejects.toThrow(/marketing_draft_stale/);
    } finally {
      await a.end();
    }
  });

  it("a conditional update can't touch a draft that was just published", async () => {
    await create(null);
    await publish(1);
    const res = await pool.query(
      `UPDATE ${TABLE} SET revision = 2 WHERE status = 'draft' AND revision = 1`,
    );
    expect(res.rowCount).toBe(0);
  });

  it("has RLS on and no policies", async () => {
    const [t] = await sql<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = '${TABLE}'::regclass`,
    );
    expect(t.relrowsecurity).toBe(true);
    const policies = await sql(`SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='marketing_page_versions'`);
    expect(policies).toHaveLength(0);
  });

  // setup.ts grants full DML on every table AFTER migrations, so relacl here
  // always shows it. Replay the whole migration in a rolled-back transaction,
  // under default privileges that mirror hosted Supabase, and check the result.
  // Real privileges are also checked on dev.
  it("the whole migration leaves anon and authenticated with nothing, despite hosted default grants", async () => {
    const file = path.join(process.cwd(), "supabase/migrations/20261102120000_marketing_page_versions.sql");
    const migration = fs
      .readFileSync(file, "utf8")
      .replace(/^BEGIN;\s*$/m, "")
      .replace(/^COMMIT;\s*$/m, "");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
        DROP FUNCTION public.publish_marketing_draft(integer, uuid);
        DROP FUNCTION public.create_marketing_draft(uuid, jsonb, uuid);
        DROP TABLE ${TABLE};
      `);
      await client.query(migration);
      for (const role of ["anon", "authenticated"]) {
        for (const fn of FUNCTIONS) {
          const { rows: r } = await client.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
          expect(r[0].ok, `${role} ${fn}`).toBe(false);
        }
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const { rows: r } = await client.query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, TABLE, priv]);
          expect(r[0].ok, `${role} ${priv}`).toBe(false);
        }
      }
      // A comma list would pass if ANY one were held, so check each.
      for (const priv of ["SELECT", "INSERT", "UPDATE"]) {
        const { rows: s } = await client.query(`SELECT has_table_privilege('service_role', $1, $2) AS ok`, [TABLE, priv]);
        expect(s[0].ok, `service_role ${priv}`).toBe(true);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it.each(FUNCTIONS)("%s is executable by service_role only", async (fn) => {
    for (const role of ["anon", "authenticated"]) {
      const [r] = await sql<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
      expect(r.ok, role).toBe(false);
    }
    const [s] = await sql<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn]);
    expect(s.ok).toBe(true);
    const [p] = await sql<{ public_exec: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.oid = $1::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS public_exec`,
      [fn],
    );
    expect(p.public_exec).toBe(false);
  });

  it("creates the bucket with limits and no write policies", async () => {
    const [b] = await sql<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
      `SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'marketing-assets'`,
    );
    expect(b.public).toBe(true);
    expect(Number(b.file_size_limit)).toBe(4 * 1024 * 1024);
    expect([...b.allowed_mime_types].sort()).toEqual(["image/jpeg", "image/png", "image/webp"]);
    const policies = await sql(
      `SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND (COALESCE(qual,'') LIKE '%marketing-assets%' OR COALESCE(with_check,'') LIKE '%marketing-assets%')`,
    );
    expect(policies).toHaveLength(0);
  });
});
