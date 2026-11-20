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
let fieldId = "";
let intakeId = "";

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
  const [i] = await sql<{ id: string }>(
    `INSERT INTO public.intakes (tenant_id, name, year) VALUES ($1, 'PW intake', 2026) RETURNING id`,
    [tenantId],
  );
  intakeId = i.id;
  const [c] = await sql<{ id: string }>(
    `INSERT INTO public.classes (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining)
     VALUES ($1, $2, 'PW', 0, 1, 1) RETURNING id`,
    [tenantId, intakeId],
  );
  await sql(
    `INSERT INTO public.class_channels (tenant_id, intake_id, class_id, telegram_channel_id)
     VALUES ($1, $2, $3, 'pw-channel')`,
    [tenantId, intakeId, c.id],
  );
  const [f] = await sql<{ id: string }>(
    `INSERT INTO public.intake_form_fields (intake_id, field_key, field_label, field_type)
     VALUES ($1, 'pw_field', 'PW field', 'text') RETURNING id`,
    [intakeId],
  );
  fieldId = f.id;
});

afterAll(async () => {
  await sql(`DELETE FROM public.users WHERE id = $1`, [userId]);
  // Intake, class, channel and form-field rows go with the tenant (ON DELETE CASCADE).
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

// Runs arbitrary SQL as the authenticated role (or another role) with the given
// JWT claims inside a transaction that is always rolled back. Errors propagate
// with their SQLSTATE in `.code`.
async function runAs(
  claims: Record<string, unknown>,
  text: string,
  params: unknown[] = [],
  role = "authenticated",
) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role, ...claims }),
    ]);
    const res = await client.query(text, params);
    return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

const PASSWORD = { amr: [{ method: "password", timestamp: 1 }] };
const EMAIL_CODE = { amr: [{ method: "otp", timestamp: 1 }] };

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

describe("class_channels policies by behaviour", () => {
  const read = `SELECT id FROM public.class_channels WHERE tenant_id = $1`;

  it("a password session sees its tenant's rows", async () => {
    expect((await runAs(PASSWORD, read, [tenantId])).rowCount).toBe(1);
  });

  it.each([
    ["an email code", EMAIL_CODE],
    ["no amr", {}],
  ])("%s sees no rows", async (_label, claims) => {
    expect((await runAs(claims, read, [tenantId])).rowCount).toBe(0);
  });

  it("an email-code session cannot insert a row for the tenant (row-level security)", async () => {
    await expect(
      runAs(
        EMAIL_CODE,
        `INSERT INTO public.class_channels (tenant_id, intake_id, class_id, telegram_channel_id)
         VALUES ($1, $2, gen_random_uuid(), 'pw-other')`,
        [tenantId, intakeId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("intake_form_fields management by behaviour", () => {
  const update = `UPDATE public.intake_form_fields SET field_label = 'PW field 2' WHERE id = $1`;

  it("a password session can update the tenant's field", async () => {
    expect((await runAs(PASSWORD, update, [fieldId])).rowCount).toBe(1);
  });

  it("an email-code session updates 0 rows", async () => {
    expect((await runAs(EMAIL_CODE, update, [fieldId])).rowCount).toBe(0);
  });
});

describe("users_select by behaviour", () => {
  it("a password session sees its own users row", async () => {
    const r = await runAs(PASSWORD, `SELECT id FROM public.users WHERE id = $1`, [userId]);
    expect(r.rowCount).toBe(1);
  });

  it("an email-code session sees 0 rows of public.users", async () => {
    expect((await runAs(EMAIL_CODE, `SELECT id FROM public.users`)).rowCount).toBe(0);
  });
});

describe("get_tenant_revenue by behaviour", () => {
  const call = `SELECT public.get_tenant_revenue($1) AS total`;

  it("returns a number for a password session on its own tenant", async () => {
    const r = await runAs(PASSWORD, call, [tenantId]);
    expect(Number(r.rows[0].total)).toBe(0);
  });

  it("returns 42501 for a password session on another tenant", async () => {
    await expect(runAs(PASSWORD, call, [randomUUID()])).rejects.toMatchObject({ code: "42501" });
  });

  it("returns 42501 for an email-code session on its own tenant", async () => {
    await expect(runAs(EMAIL_CODE, call, [tenantId])).rejects.toMatchObject({ code: "42501" });
  });

  it("returns a number for the service role on any tenant", async () => {
    const r = await runAs({}, call, [randomUUID()], "service_role");
    expect(Number(r.rows[0].total)).toBe(0);
  });

  it("returns 42501 when the session has no amr", async () => {
    await expect(runAs({}, call, [tenantId])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("is_password_session for anon", () => {
  it("returns false without an error", async () => {
    const r = await runAs({}, `SELECT public.is_password_session() AS ok`, [], "anon");
    expect(r.rows[0].ok).toBe(false);
  });
});
