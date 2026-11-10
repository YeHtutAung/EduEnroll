import { describe, it, expect, afterAll } from "vitest";
import { Pool, Client } from "pg";

// ─── tenants: no INSERT for anon or authenticated ────────────────────────────
// Tenant rows are created only through the service role (/api/saas/register,
// scripts/seed-e2e.ts). The harness (setup.ts, section 3) grants full DML on
// every public table to anon/authenticated, mirroring hosted Supabase, so what
// stops an insert here is row security alone — the same as in a real project.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

afterAll(async () => {
  await pool.end();
});

describe("tenants insert policy", () => {
  it("tenants has RLS on and no INSERT or ALL policy", async () => {
    const [c] = await sql<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenants'::regclass`,
    );
    expect(c.relrowsecurity).toBe(true);
    const policies = await sql<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'tenants' AND cmd IN ('INSERT', 'ALL')`,
    );
    expect(policies).toEqual([]);
  });

  it("keeps the select and update policies", async () => {
    const policies = await sql<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'tenants' ORDER BY policyname`,
    );
    expect(policies.map((p) => p.policyname)).toEqual(["tenants_select", "tenants_update"]);
  });

  it.each(["anon", "authenticated"])("%s cannot insert a tenant", async (role) => {
    const subdomain = `rls-${role}-${Date.now()}`;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      if (role === "authenticated") {
        await client.query(
          `SELECT set_config('request.jwt.claims', $1, true)`,
          [JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", role: "authenticated" })],
        );
      }
      await expect(
        client.query(`INSERT INTO public.tenants (name, subdomain) VALUES ($1, $2)`, ["RLS probe", subdomain]),
      ).rejects.toThrow(/row-level security|permission denied/);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
    expect(await sql(`SELECT 1 FROM public.tenants WHERE subdomain = $1`, [subdomain])).toEqual([]);
  });

  it("the table owner (stand-in for the service role) can still insert", async () => {
    const subdomain = `rls-owner-${Date.now()}`;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO public.tenants (name, subdomain) VALUES ($1, $2) RETURNING id`,
        ["RLS probe", subdomain],
      );
      expect(res.rowCount).toBe(1);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  });
});
