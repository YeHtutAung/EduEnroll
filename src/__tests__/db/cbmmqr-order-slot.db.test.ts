import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { Pool, Client } from "pg";

// ─── CB Bank MMQR order functions, against the REAL database ─────────────────
//
// These cannot be mocked. The guarantees under test are a row lock, a partial
// unique index, and READ COMMITTED re-evaluation of a FOR UPDATE predicate —
// none of which exist in a mock. A mocked version of this suite would pass
// while the real concurrency defect shipped.
//
// Covers spec R4 (one live order), R5/R9/R13 (claim outcome classification)
// and the P1 review findings (tenant + status must be re-proven under the lock).

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

const AMOUNT = 40000;
const future = () => new Date(Date.now() + 120 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

const REF = (n: number) => `CB${String(n).padStart(23, "A")}`; // 25 chars, like buildReferenceNo()

type ClaimRow = {
  outcome: string; payment_id: string | null; ref: string | null; qr: string | null;
  merchant: string | null; expires_at: string | null; order_ref: string | null; created_at: string | null;
};

const claim = (enrollmentId: string, tenantId: string, ref: string, amount = AMOUNT,
               expiresAt: string = future(), platformFee = 0) =>
  sql<ClaimRow>(
    `SELECT * FROM public.claim_cbmmqr_order_slot($1,$2,$3,$4,$5::timestamptz,$6)`,
    [enrollmentId, tenantId, ref, amount, expiresAt, platformFee],
  );

const replace = (enrollmentId: string, tenantId: string, oldRef: string, reason: string, newRef: string) =>
  sql<{ outcome: string; payment_id: string | null; merchant: string | null }>(
    `SELECT * FROM public.complete_cbmmqr_replace($1,$2,$3,$4,$5,$6,$7::timestamptz,0)`,
    [enrollmentId, tenantId, oldRef, reason, newRef, AMOUNT, future()],
  );

const store = async (ref: string, qr: string | null, orderRef: string) =>
  (await sql<{ r: string }>(`SELECT public.store_cbmmqr_qr($1,$2,$3,$4::timestamptz) AS r`,
    [ref, qr, orderRef, future()]))[0].r;

const bind = async (ref: string, qrRef: string, txn: string, merchant = "YOUNGMONEY") =>
  (await sql<{ r: string }>(`SELECT public.bind_cbmmqr_settlement($1,$2,$3,$4) AS r`,
    [ref, qrRef, txn, merchant]))[0].r;

// ── Fixtures ────────────────────────────────────────────────────────────────

type Tracked = { tenants: string[]; intakes: string[]; classes: string[]; enrollments: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], enrollments: [] });
let seq = 0;
const uniq = () => `cb${Date.now().toString(36)}${seq++}`;

async function makeWorld(opts: { enrollmentStatus?: string; merchant?: string | null } = {}) {
  const { enrollmentStatus = "pending_payment", merchant = "YOUNGMONEY" } = opts;
  const slug = uniq();
  const [t] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1,$2,'event') RETURNING id`,
    [`CB ${slug}`, slug],
  );
  made.tenants.push(t.id);
  if (merchant) {
    await sql(
      `INSERT INTO cbmmqr_merchant_assignments (tenant_id, merchant_id) VALUES ($1,$2)`,
      [t.id, merchant],
    );
  }
  const [i] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1,'CB intake',2026) RETURNING id`,
    [t.id],
  );
  made.intakes.push(i.id);
  const [c] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id,intake_id,level,fee_amount,seat_total,seat_remaining,status,
                          max_tickets_per_person)
     VALUES ($1,$2,$3,${AMOUNT},50,40,'open',10) RETURNING id`,
    [t.id, i.id, `L${uniq()}`],
  );
  made.classes.push(c.id);
  const [e] = await sql<{ id: string }>(
    `INSERT INTO enrollments (enrollment_ref,tenant_id,student_name_en,phone,class_id,quantity,status)
     VALUES ('',$1,'CB Test','09000000000',$2,1,$3::enrollment_status) RETURNING id`,
    [t.id, c.id, enrollmentStatus],
  );
  made.enrollments.push(e.id);
  return { tenantId: t.id, enrollmentId: e.id };
}

/** Seed a live CB order directly, bypassing the claim function. */
async function seedLive(
  enrollmentId: string, tenantId: string, ref: string,
  opts: { qr?: string | null; amount?: number; expiresAt?: string; merchant?: string; orderRef?: string | null } = {},
) {
  const { qr = "0002010102QR", amount = AMOUNT, expiresAt = future(), merchant = "YOUNGMONEY", orderRef = null } = opts;
  const [p] = await sql<{ id: string }>(
    `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_ref, payment_method, mmqr_status,
                           status, provider_qr, provider_order_expires_at, cbmmqr_merchant, provider_order_ref)
     VALUES ($1,$2,$3,$4,'cb_mmqr','PENDING','awaiting_payment',$5,$6::timestamptz,$7,$8) RETURNING id`,
    [enrollmentId, tenantId, amount, ref, qr, expiresAt, merchant, orderRef],
  );
  return p.id;
}

const liveRows = (enrollmentId: string) =>
  sql<{ id: string; payment_ref: string; mmqr_status: string; tenant_id: string; amount: number }>(
    `SELECT id, payment_ref, mmqr_status, tenant_id, amount FROM payments
      WHERE enrollment_id=$1 AND payment_method='cb_mmqr'
        AND status='awaiting_payment' AND mmqr_status='PENDING'`,
    [enrollmentId],
  );

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1");
});

afterEach(async () => {
  const { tenants, intakes, classes, enrollments } = made;
  if (enrollments.length) {
    await sql(`DELETE FROM tickets  WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM payments WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM enrollments WHERE id = ANY($1::uuid[])`, [enrollments]);
  }
  if (classes.length) await sql(`DELETE FROM classes WHERE id = ANY($1::uuid[])`, [classes]);
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  if (tenants.length) {
    await sql(`DELETE FROM cbmmqr_merchant_assignments WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
  }
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

describe("claim_cbmmqr_order_slot", () => {
  it("created: one PENDING awaiting_payment row pinned to the assignment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const [r] = await claim(enrollmentId, tenantId, REF(1));
    expect(r.outcome).toBe("created");
    expect(r.merchant).toBe("YOUNGMONEY");
    const [row] = await sql(`SELECT status, mmqr_status, cbmmqr_merchant FROM payments WHERE id=$1`, [r.payment_id]);
    expect(row).toEqual({ status: "awaiting_payment", mmqr_status: "PENDING", cbmmqr_merchant: "YOUNGMONEY" });
  });

  it("reuse: same amount, stored QR, inside the expiry", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: "0002QR" });
    const [r] = await claim(enrollmentId, tenantId, REF(2));
    expect(r.outcome).toBe("reuse");
    expect(r.qr).toBe("0002QR");
    expect(r.expires_at).toBeTruthy();
  });

  it.each([
    ["a different amount", { amount: AMOUNT + 1 }],
    ["no stored QR", { qr: null }],
    ["a passed expiry", { expiresAt: past() }],
  ])("unresolved with %s, returning the old row's reference; inserts nothing", async (_n, opts) => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { ...opts, orderRef: "QR-1" });
    const [r] = await claim(enrollmentId, tenantId, REF(2));
    expect(r).toMatchObject({ outcome: "unresolved", ref: REF(1), order_ref: "QR-1", merchant: "YOUNGMONEY" });
    expect(await liveRows(enrollmentId)).toHaveLength(1);
  });

  it("invalid_enrollment for another tenant's enrollment or a rejected one", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    expect((await claim(a.enrollmentId, b.tenantId, REF(1)))[0].outcome).toBe("invalid_enrollment");
    const r = await makeWorld({ enrollmentStatus: "rejected" });
    expect((await claim(r.enrollmentId, r.tenantId, REF(2)))[0].outcome).toBe("invalid_enrollment");
  });

  it("no_merchant without an assignment, and inserts nothing", async () => {
    const { tenantId, enrollmentId } = await makeWorld({ merchant: null });
    expect((await claim(enrollmentId, tenantId, REF(1)))[0].outcome).toBe("no_merchant");
    expect(await liveRows(enrollmentId)).toHaveLength(0);
  });

  it("two concurrent claims leave exactly one live row", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const results = await Promise.allSettled([
      claim(enrollmentId, tenantId, REF(1)),
      claim(enrollmentId, tenantId, REF(2)),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const outcomes = results.map((r) => (r as PromiseFulfilledResult<ClaimRow[]>).value[0].outcome).sort();
    expect(outcomes).toEqual(["created", "unresolved"]);
    expect(await liveRows(enrollmentId)).toHaveLength(1);
  });
});

describe("store_cbmmqr_qr", () => {
  const read = async (ref: string) =>
    (await sql(`SELECT provider_qr, provider_order_ref FROM payments WHERE payment_ref=$1`, [ref]))[0];

  it("stored: QR, reference and expiry on a live row of a payable enrollment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null });
    expect(await store(REF(1), "0002QR", "QR-1")).toBe("stored");
    expect(await read(REF(1))).toEqual({ provider_qr: "0002QR", provider_order_ref: "QR-1" });
  });

  it("not_payable: enrollment rejected meanwhile — reference stored, QR withheld", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null });
    await sql(`UPDATE enrollments SET status='rejected' WHERE id=$1`, [enrollmentId]);
    expect(await store(REF(1), "0002QR", "QR-1")).toBe("not_payable");
    expect(await read(REF(1))).toEqual({ provider_qr: null, provider_order_ref: "QR-1" });
  });

  it("stored without a QR when p_qr is null (post-check failed)", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null });
    expect(await store(REF(1), null, "QR-1")).toBe("stored");
    expect(await read(REF(1))).toEqual({ provider_qr: null, provider_order_ref: "QR-1" });
  });

  it("ref_conflict when a different reference is already stored", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null, orderRef: "QR-1" });
    expect(await store(REF(1), "0002QR", "QR-2")).toBe("ref_conflict");
  });

  it("raises when the order reference is empty", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null });
    await expect(store(REF(1), "0002QR", "")).rejects.toThrow(/p_order_ref is required/);
  });

  it("not_live for a retired row; not_found for an unknown reference", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null });
    await sql(`UPDATE payments SET mmqr_status='EXPIRED' WHERE payment_ref=$1`, [REF(1)]);
    expect(await store(REF(1), "0002QR", "QR-1")).toBe("not_live");
    expect(await store(REF(9), "0002QR", "QR-9")).toBe("not_found");
  });
});

describe("complete_cbmmqr_replace", () => {
  it("replaced: old row retired, new row pinned and the only live one", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1));
    const [r] = await replace(enrollmentId, tenantId, REF(1), "EXPIRED", REF(2));
    expect(r).toMatchObject({ outcome: "replaced", merchant: "YOUNGMONEY" });
    expect((await liveRows(enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(2)]);
    const [old] = await sql(`SELECT mmqr_status FROM payments WHERE payment_ref=$1`, [REF(1)]);
    expect(old).toEqual({ mmqr_status: "EXPIRED" });
  });

  it("raises on SUPERSEDED", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1));
    await expect(replace(enrollmentId, tenantId, REF(1), "SUPERSEDED", REF(2))).rejects.toThrow(/invalid reason/);
  });

  it("invalid_enrollment for the wrong tenant", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    await seedLive(a.enrollmentId, a.tenantId, REF(1));
    expect((await replace(a.enrollmentId, b.tenantId, REF(1), "EXPIRED", REF(2)))[0].outcome).toBe("invalid_enrollment");
  });

  it("already_settled when settlement won the race", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1));
    await sql(`UPDATE payments SET status='verified', mmqr_status='SUCCESS' WHERE payment_ref=$1`, [REF(1)]);
    expect((await replace(enrollmentId, tenantId, REF(1), "EXPIRED", REF(2)))[0].outcome).toBe("already_settled");
  });

  it("not_live, not_payable and no_merchant leave the old row live and untouched", async () => {
    const w = await makeWorld();
    await seedLive(w.enrollmentId, w.tenantId, REF(1));
    await sql(`UPDATE payments SET mmqr_status='FAILED' WHERE payment_ref=$1`, [REF(1)]);
    expect((await replace(w.enrollmentId, w.tenantId, REF(1), "EXPIRED", REF(2)))[0].outcome).toBe("not_live");

    const r = await makeWorld();
    await seedLive(r.enrollmentId, r.tenantId, REF(3));
    await sql(`UPDATE enrollments SET status='rejected' WHERE id=$1`, [r.enrollmentId]);
    expect((await replace(r.enrollmentId, r.tenantId, REF(3), "EXPIRED", REF(4)))[0].outcome).toBe("not_payable");
    expect((await liveRows(r.enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(3)]);

    const n = await makeWorld();
    await seedLive(n.enrollmentId, n.tenantId, REF(5));
    await sql(`DELETE FROM cbmmqr_merchant_assignments WHERE tenant_id=$1`, [n.tenantId]);
    expect((await replace(n.enrollmentId, n.tenantId, REF(5), "EXPIRED", REF(6)))[0].outcome).toBe("no_merchant");
    expect((await liveRows(n.enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(5)]);
  });

  it("settling: refuses to retire a row a settlement has already bound", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null, orderRef: null });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    expect((await replace(enrollmentId, tenantId, REF(1), "FAILED", REF(2)))[0].outcome).toBe("settling");
    expect((await liveRows(enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(1)]);
  });

  it("a replace racing a bind on the same row: the replace waits, then answers settling", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null, orderRef: null });
    // Hold the bind's row lock open in its own transaction.
    const binder = new Client({ connectionString: process.env.DATABASE_URL });
    await binder.connect();
    try {
      await binder.query("BEGIN");
      await binder.query(`SELECT public.bind_cbmmqr_settlement($1,'QR-1','TXN-1','YOUNGMONEY')`, [REF(1)]);
      const pending = replace(enrollmentId, tenantId, REF(1), "FAILED", REF(2));
      // Wait until the replace is actually blocked on a lock.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const rows = await sql(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND query LIKE '%complete_cbmmqr_replace%' AND pid <> pg_backend_pid()`);
        blocked = rows.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked).toBe(true);
      await binder.query("COMMIT");
      expect((await pending)[0].outcome).toBe("settling");
    } finally {
      await binder.end();
    }
    expect((await liveRows(enrollmentId)).map((x) => x.payment_ref)).toEqual([REF(1)]);
  });
});

describe("bind_cbmmqr_settlement", () => {
  it("bound, and a replay with the same values is bound again", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
  });

  it("binds provider_order_ref when it was never stored (lost create response)", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { qr: null, orderRef: null });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    const [p] = await sql(`SELECT provider_order_ref, bank_reference FROM payments WHERE payment_ref=$1`, [REF(1)]);
    expect(p).toEqual({ provider_order_ref: "QR-1", bank_reference: "TXN-1" });
  });

  it.each([
    ["a different QR reference", "QR-2", "TXN-1", "YOUNGMONEY"],
    ["another merchant", "QR-1", "TXN-1", "OTHER"],
    ["an empty transaction id", "QR-1", "", "YOUNGMONEY"],
  ])("mismatch for %s", async (_n, qrRef, txn, merchant) => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    expect(await bind(REF(1), qrRef, txn, merchant)).toBe("mismatch");
  });

  it("mismatch for a second, different transaction on the same payment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    expect(await bind(REF(1), "QR-1", "TXN-2")).toBe("mismatch");
  });

  it("duplicate_transaction when the transaction already bound another payment", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    await seedLive(a.enrollmentId, a.tenantId, REF(1), { orderRef: "QR-1" });
    await seedLive(b.enrollmentId, b.tenantId, REF(2), { orderRef: "QR-2" });
    expect(await bind(REF(1), "QR-1", "TXN-1")).toBe("bound");
    expect(await bind(REF(2), "QR-2", "TXN-1")).toBe("duplicate_transaction");
  });

  it("duplicate_order_ref when the QR reference already belongs to another payment", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    await seedLive(a.enrollmentId, a.tenantId, REF(1), { orderRef: "QR-1" });
    await seedLive(b.enrollmentId, b.tenantId, REF(2), { orderRef: null });
    expect(await bind(REF(2), "QR-1", "TXN-9")).toBe("duplicate_order_ref");
  });

  it("two concurrent binds with different transactions: exactly one is bound", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    const out = await Promise.all([bind(REF(1), "QR-1", "TXN-1"), bind(REF(1), "QR-1", "TXN-2")]);
    expect(out.sort()).toEqual(["bound", "mismatch"]);
  });

  it("not_found for a reference that is not a CB payment", async () => {
    expect(await bind("KBZ_none", "QR-1", "TXN-1")).toBe("not_found");
  });
});

describe("trg_protect_payment_cbmmqr_fields and the CHECK", () => {
  it("refuses a pin that does not match the assignment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await expect(seedLive(enrollmentId, tenantId, REF(1), { merchant: "OTHER" }))
      .rejects.toThrow(/does not match the tenant assignment/);
  });

  it("refuses changing the pin, provider_order_ref or a CB bank_reference once set", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1), { orderRef: "QR-1" });
    await sql(`UPDATE payments SET bank_reference='TXN-1' WHERE payment_ref=$1`, [REF(1)]);
    for (const set of [
      "cbmmqr_merchant='OTHER'", "provider_order_ref='QR-2'", "provider_order_ref=NULL", "bank_reference='TXN-2'",
    ]) {
      await expect(sql(`UPDATE payments SET ${set} WHERE payment_ref=$1`, [REF(1)])).rejects.toThrow(/immutable|write-once/);
    }
  });

  it("refuses provider_order_ref on a non-CB row, and a CB row without a pin", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await expect(sql(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, provider_order_ref)
       VALUES ($1,$2,1000,'bank_transfer','awaiting_payment','QR-1')`, [enrollmentId, tenantId],
    )).rejects.toThrow(/only valid on cb_mmqr/);
    await expect(sql(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_method, status, mmqr_status)
       VALUES ($1,$2,1000,'cb_mmqr','awaiting_payment','PENDING')`, [enrollmentId, tenantId],
    )).rejects.toThrow(/payments_cbmmqr_merchant_required/);
  });
});

describe("trigger and CHECK: tenant move, method change, non-CB bank_reference", () => {
  it("refuses moving a pinned CB row to another tenant", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    await seedLive(a.enrollmentId, a.tenantId, REF(1));
    await expect(sql(`UPDATE payments SET tenant_id=$2 WHERE payment_ref=$1`, [REF(1), b.tenantId]))
      .rejects.toThrow(/cannot move tenant/);
  });

  it("refuses changing payment_method away from cb_mmqr on a pinned row", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, REF(1));
    await expect(sql(`UPDATE payments SET payment_method='bank_transfer' WHERE payment_ref=$1`, [REF(1)]))
      .rejects.toThrow(/payments_cbmmqr_merchant_required/);
  });

  it("still lets a non-CB row's bank_reference be updated repeatedly", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await sql(
      `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_ref, payment_method, status)
       VALUES ($1,$2,1000,$3,'bank_transfer','awaiting_payment')`, [enrollmentId, tenantId, REF(7)]);
    await sql(`UPDATE payments SET bank_reference='A' WHERE payment_ref=$1`, [REF(7)]);
    await sql(`UPDATE payments SET bank_reference='B' WHERE payment_ref=$1`, [REF(7)]);
    const [p] = await sql(`SELECT bank_reference FROM payments WHERE payment_ref=$1`, [REF(7)]);
    expect(p).toEqual({ bank_reference: "B" });
  });
});

describe("cbmmqr_merchant_assignments", () => {
  it("a reassignment advances updated_at", async () => {
    const { tenantId } = await makeWorld();
    const at = async () => (await sql<{ updated_at: Date }>(
      `SELECT updated_at FROM cbmmqr_merchant_assignments WHERE tenant_id=$1`, [tenantId]))[0].updated_at.getTime();
    const before = await at();
    await sql(`SELECT pg_sleep(0.02)`);
    await sql(`UPDATE cbmmqr_merchant_assignments SET merchant_id='OTHER' WHERE tenant_id=$1`, [tenantId]);
    expect(await at()).toBeGreaterThan(before);
  });
});

describe("grants", () => {
  const can = async (role: string, privilege: string) =>
    (await sql<{ ok: boolean }>(
      `SELECT has_table_privilege($1,'public.cbmmqr_merchant_assignments',$2) AS ok`, [role, privilege]))[0].ok;
  const canExec = async (role: string, fn: string) =>
    (await sql<{ ok: boolean }>(`SELECT has_function_privilege($1,$2,'EXECUTE') AS ok`, [role, fn]))[0].ok;

  it("service_role manages assignments", async () => {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(await can("service_role", p)).toBe(true);
    }
  });

  // setup.ts re-grants full DML on every public table to anon/authenticated
  // (mirroring hosted Supabase), so has_table_privilege cannot show the
  // migration's REVOKE here. What keeps them out is RLS with no policy.
  it("anon and authenticated are locked out by RLS with no policies", async () => {
    const [t] = await sql<{ rls: boolean }>(
      `SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.cbmmqr_merchant_assignments'::regclass`);
    expect(t.rls).toBe(true);
    const [p] = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies WHERE schemaname='public' AND tablename='cbmmqr_merchant_assignments'`);
    expect(p.n).toBe("0");
  });

  it.each([
    "public.claim_cbmmqr_order_slot(uuid,uuid,text,integer,timestamptz,integer)",
    "public.store_cbmmqr_qr(text,text,text,timestamptz)",
    "public.complete_cbmmqr_replace(uuid,uuid,text,text,text,integer,timestamptz,integer)",
    "public.bind_cbmmqr_settlement(text,text,text,text)",
  ])("only service_role can execute %s", async (fn) => {
    expect(await canExec("service_role", fn)).toBe(true);
    expect(await canExec("anon", fn)).toBe(false);
    expect(await canExec("authenticated", fn)).toBe(false);
  });
});
