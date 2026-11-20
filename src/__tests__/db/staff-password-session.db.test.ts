import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { randomUUID } from "crypto";

// ─── Staff helpers answer only for password sessions ─────────────────────────
// get_my_tenant_id() and get_my_role() back almost every staff RLS policy.
// They must return NULL unless the JWT's amr shows a password sign-in, so an
// email-code session (buyer sign-in, project-wide) never opens staff data.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

const userId = randomUUID();
let tenantId = "";

beforeAll(async () => {
  await sql(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [userId, `pw-${userId}@example.test`]);
  const [t] = await sql<{ id: string }>(
    `INSERT INTO public.tenants (name, subdomain) VALUES ('PW probe', $1) RETURNING id`,
    [`pw-${Date.now()}`],
  );
  tenantId = t.id;
  await sql(
    `INSERT INTO public.users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'owner')`,
    [userId, tenantId, `pw-${userId}@example.test`],
  );
});

afterAll(async () => {
  await sql(`DELETE FROM public.users WHERE id = $1`, [userId]);
  await sql(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
  await sql(`DELETE FROM auth.users WHERE id = $1`, [userId]);
  await pool.end();
});

async function asUser(claims: Record<string, unknown>) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated", ...claims }),
    ]);
    const { rows } = await client.query(
      `SELECT public.get_my_tenant_id() AS tenant, public.get_my_role()::text AS role`,
    );
    return rows[0] as { tenant: string | null; role: string | null };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

describe("staff helpers and sign-in method", () => {
  it("answer for a password session (object form)", async () => {
    expect(await asUser({ amr: [{ method: "password", timestamp: 1 }] })).toEqual({
      tenant: tenantId,
      role: "owner",
    });
  });

  it("answer for a password session (string form)", async () => {
    expect((await asUser({ amr: ["password"] })).tenant).toBe(tenantId);
  });

  it.each([
    ["an email code", { amr: [{ method: "otp", timestamp: 1 }] }],
    ["a magic link", { amr: [{ method: "magiclink", timestamp: 1 }] }],
    ["no amr", {}],
  ])("return NULL for %s", async (_label, claims) => {
    expect(await asUser(claims)).toEqual({ tenant: null, role: null });
  });

  it("every staff policy that used to read users directly now goes through the rule", async () => {
    const policies = await sql<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
      `SELECT tablename, policyname, qual, with_check FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('class_channels', 'intake_form_fields')
          AND policyname <> 'intake_form_fields_public_read'`,
    );
    expect(policies.length).toBe(5);
    for (const p of policies) {
      const text = `${p.qual ?? ""} ${p.with_check ?? ""}`;
      expect(text, `${p.tablename}.${p.policyname}`).toMatch(/get_my_tenant_id|is_password_session/);
      if (p.tablename === "class_channels") {
        // No direct users lookup left beside the helper.
        expect(text, `${p.tablename}.${p.policyname}`).not.toMatch(/FROM\s+(public\.)?users/i);
      }
    }
  });
});
