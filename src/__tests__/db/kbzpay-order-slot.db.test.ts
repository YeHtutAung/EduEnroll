import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { Pool, Client } from "pg";

// ─── KBZPay order-slot functions, against the REAL database ─────────────────
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

type ClaimRow = { outcome: string; payment_id: string | null; ref: string | null; qr: string | null };
type SupersedeRow = { outcome: string; payment_id: string | null };

const claim = (
  enrollmentId: string,
  tenantId: string,
  ref: string,
  amount = AMOUNT,
  expiresAt: string = future(),
) =>
  sql<ClaimRow>(`SELECT * FROM public.claim_kbzpay_order_slot($1,$2,$3,$4,$5::timestamptz)`, [
    enrollmentId,
    tenantId,
    ref,
    amount,
    expiresAt,
  ]);

const supersede = (
  enrollmentId: string,
  tenantId: string,
  oldRef: string,
  reason: string,
  newRef: string,
  amount = AMOUNT,
) =>
  sql<SupersedeRow>(
    `SELECT * FROM public.complete_kbzpay_supersede($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
    [enrollmentId, tenantId, oldRef, reason, newRef, amount, future()],
  );

// ── Fixtures ────────────────────────────────────────────────────────────────

type Tracked = { tenants: string[]; intakes: string[]; classes: string[]; enrollments: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], enrollments: [] });
let seq = 0;
const uniq = () => `kbz${Date.now().toString(36)}${seq++}`;

async function makeWorld(opts: { enrollmentStatus?: string } = {}) {
  const { enrollmentStatus = "pending_payment" } = opts;
  const slug = uniq();
  const [t] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1,$2,'event') RETURNING id`,
    [`KBZ ${slug}`, slug],
  );
  made.tenants.push(t.id);
  const [i] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1,'KBZ intake',2026) RETURNING id`,
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
     VALUES ('',$1,'KBZ Test','09000000000',$2,1,$3::enrollment_status) RETURNING id`,
    [t.id, c.id, enrollmentStatus],
  );
  made.enrollments.push(e.id);
  return { tenantId: t.id, enrollmentId: e.id };
}

/** Seed a live KBZPay order directly, bypassing the claim function. */
async function seedLive(
  enrollmentId: string,
  tenantId: string,
  ref: string,
  opts: { qr?: string | null; amount?: number; expiresAt?: string } = {},
) {
  const { qr = "0002010102QR", amount = AMOUNT, expiresAt = future() } = opts;
  const [p] = await sql<{ id: string }>(
    `INSERT INTO payments (enrollment_id, tenant_id, amount, payment_ref, payment_method,
                           mmqr_status, status, provider_qr, provider_order_expires_at)
     VALUES ($1,$2,$3,$4,'kbzpay_mmqr','PENDING','awaiting_payment',$5,$6::timestamptz)
     RETURNING id`,
    [enrollmentId, tenantId, amount, ref, qr, expiresAt],
  );
  return p.id;
}

const liveRows = (enrollmentId: string) =>
  sql<{ id: string; payment_ref: string; mmqr_status: string; tenant_id: string; amount: number }>(
    `SELECT id, payment_ref, mmqr_status, tenant_id, amount FROM payments
      WHERE enrollment_id=$1 AND payment_method='kbzpay_mmqr'
        AND status='awaiting_payment' AND mmqr_status='PENDING'`,
    [enrollmentId],
  );

const allKbzRows = (enrollmentId: string) =>
  sql<{ payment_ref: string; mmqr_status: string; status: string }>(
    `SELECT payment_ref, mmqr_status, status FROM payments
      WHERE enrollment_id=$1 AND payment_method='kbzpay_mmqr' ORDER BY created_at`,
    [enrollmentId],
  );

const enrollmentStatusOf = async (id: string) =>
  (await sql<{ status: string }>(`SELECT status FROM enrollments WHERE id=$1`, [id]))[0].status;

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
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
});

afterAll(async () => {
  await pool.end();
});

// ─── claim_kbzpay_order_slot ────────────────────────────────────────────────

describe("claim_kbzpay_order_slot", () => {
  it("returns created and inserts exactly one PENDING row when none exists", async () => {
    const { tenantId, enrollmentId } = await makeWorld();

    const [r] = await claim(enrollmentId, tenantId, "KBZ_a_1");

    expect(r.outcome).toBe("created");
    expect(r.payment_id).toBeTruthy();
    expect(r.qr).toBeNull();

    const rows = await liveRows(enrollmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payment_ref).toBe("KBZ_a_1");
  });

  // The insert must use awaiting_payment, never pending: the INSERT branch of
  // trg_payments_sync_enrollment fires on 'pending' and would advance the
  // enrollment before a QR exists. Migration 054 exists for this.
  it("does not advance the enrollment — status stays pending_payment", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await claim(enrollmentId, tenantId, "KBZ_a_2");
    expect(await enrollmentStatusOf(enrollmentId)).toBe("pending_payment");
  });

  it("returns reuse when amount, QR and expiry all match", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_b_1");

    const [r] = await claim(enrollmentId, tenantId, "KBZ_b_2");

    expect(r.outcome).toBe("reuse");
    expect(r.ref).toBe("KBZ_b_1");
    expect(r.qr).toBe("0002010102QR");
    expect(await liveRows(enrollmentId)).toHaveLength(1);
  });

  // R13: this exact state — live, matching amount, but provider_qr NULL —
  // matched no branch in revision 6. It fell through to the insert and hit the
  // unique index, giving the student a repeatable 502 until expiry.
  it("returns unresolved when provider_qr is NULL even though the amount matches", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_c_1", { qr: null });

    const [r] = await claim(enrollmentId, tenantId, "KBZ_c_2");

    expect(r.outcome).toBe("unresolved");
    expect(r.ref).toBe("KBZ_c_1");
    expect(await liveRows(enrollmentId)).toHaveLength(1);
  });

  it("returns unresolved when the amount differs (R5)", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_d_1", { amount: 30000 });

    const [r] = await claim(enrollmentId, tenantId, "KBZ_d_2", AMOUNT);

    expect(r.outcome).toBe("unresolved");
    expect(r.ref).toBe("KBZ_d_1");
  });

  // R9: staleness must SHADOW reuse. Revision 4 tested reuse first, so an
  // expired QR was re-served from provider_qr with no provider check at all.
  it("returns unresolved when past the expiry hint, even at the same amount", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_e_1", { expiresAt: past() });

    const [r] = await claim(enrollmentId, tenantId, "KBZ_e_2");

    expect(r.outcome).toBe("unresolved");
    expect(r.qr).toBeNull();
  });

  // R4: the guarantee is the row lock plus idx_payments_one_live_kbzpay_order.
  it("permits only ONE live order per enrollment under concurrency", async () => {
    const { tenantId, enrollmentId } = await makeWorld();

    const [a, b] = await Promise.all([
      claim(enrollmentId, tenantId, "KBZ_f_1"),
      claim(enrollmentId, tenantId, "KBZ_f_2"),
    ]);

    const outcomes = [a[0].outcome, b[0].outcome].sort();
    // The loser sees the winner's row. It has no QR yet, so it is unresolved —
    // never a second 'created'.
    expect(outcomes).toEqual(["created", "unresolved"]);
    expect(await liveRows(enrollmentId)).toHaveLength(1);
  });

  // ── P1 review: the function must defend its own preconditions ────────────

  it("returns invalid_enrollment for a mismatched tenant and inserts nothing", async () => {
    const { enrollmentId } = await makeWorld();
    const other = await makeWorld();

    const [r] = await claim(enrollmentId, other.tenantId, "KBZ_g_1");

    expect(r.outcome).toBe("invalid_enrollment");
    expect(r.payment_id).toBeNull();
    expect(await allKbzRows(enrollmentId)).toHaveLength(0);
  });

  it.each(["payment_submitted", "confirmed", "rejected"])(
    "returns invalid_enrollment for a %s enrollment and inserts nothing",
    async (status) => {
      const { tenantId, enrollmentId } = await makeWorld({ enrollmentStatus: status });

      const [r] = await claim(enrollmentId, tenantId, `KBZ_h_${status}`);

      expect(r.outcome).toBe("invalid_enrollment");
      expect(await allKbzRows(enrollmentId)).toHaveLength(0);
    },
  );

  it.each(["pending_payment", "partial_payment"])("allows a %s enrollment", async (status) => {
    const { tenantId, enrollmentId } = await makeWorld({ enrollmentStatus: status });
    const [r] = await claim(enrollmentId, tenantId, `KBZ_i_${status}`);
    expect(r.outcome).toBe("created");
  });

  // The core of the P1 finding. Under READ COMMITTED, FOR UPDATE re-evaluates
  // the predicate after the lock is granted, so a rejection that commits while
  // the claim is blocked makes the row stop matching — the claim must fail
  // closed rather than proceed on its stale read.
  it("fails closed when the enrollment is rejected concurrently", async () => {
    const { tenantId, enrollmentId } = await makeWorld();

    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `UPDATE enrollments SET status='rejected'::enrollment_status WHERE id=$1`,
        [enrollmentId],
      );

      // Starts while the rejection is uncommitted; blocks on FOR UPDATE.
      const claimPromise = claim(enrollmentId, tenantId, "KBZ_j_1");
      await new Promise((r) => setTimeout(r, 250));
      await blocker.query("COMMIT");

      const [r] = await claimPromise;
      expect(r.outcome).toBe("invalid_enrollment");
      expect(await allKbzRows(enrollmentId)).toHaveLength(0);
    } finally {
      await blocker.end();
    }
  });

  it("attributes the payment to the enrollment's own tenant_id", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await claim(enrollmentId, tenantId, "KBZ_k_1");

    const rows = await liveRows(enrollmentId);
    expect(rows[0].tenant_id).toBe(tenantId);
  });
});

// ─── complete_kbzpay_supersede ──────────────────────────────────────────────

describe("complete_kbzpay_supersede", () => {
  it("retires the old row and inserts the replacement atomically", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_m_old");

    const [r] = await supersede(enrollmentId, tenantId, "KBZ_m_old", "SUPERSEDED", "KBZ_m_new");

    expect(r.outcome).toBe("replaced");

    const rows = await allKbzRows(enrollmentId);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.payment_ref === "KBZ_m_old")!.mmqr_status).toBe("SUPERSEDED");
    expect(await liveRows(enrollmentId)).toHaveLength(1);
    expect((await liveRows(enrollmentId))[0].payment_ref).toBe("KBZ_m_new");
  });

  // R7/R11: a callback settled the old order between the provider query and
  // this transition. Handing the student a fresh QR here would be wrong.
  it("reports already_settled and inserts NOTHING when the old row is verified", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_n_old");
    await sql(`UPDATE payments SET status='verified'::payment_status WHERE payment_ref=$1`, [
      "KBZ_n_old",
    ]);

    const [r] = await supersede(enrollmentId, tenantId, "KBZ_n_old", "SUPERSEDED", "KBZ_n_new");

    expect(r.outcome).toBe("already_settled");
    const rows = await allKbzRows(enrollmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payment_ref).toBe("KBZ_n_old");
  });

  it("reports not_live when the old row was already retired", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_o_old");
    await sql(`UPDATE payments SET mmqr_status='EXPIRED' WHERE payment_ref=$1`, ["KBZ_o_old"]);

    const [r] = await supersede(enrollmentId, tenantId, "KBZ_o_old", "SUPERSEDED", "KBZ_o_new");

    expect(r.outcome).toBe("not_live");
    expect(await allKbzRows(enrollmentId)).toHaveLength(1);
  });

  it("reports not_found for an unknown old reference", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const [r] = await supersede(enrollmentId, tenantId, "KBZ_nope", "SUPERSEDED", "KBZ_p_new");
    expect(r.outcome).toBe("not_found");
    expect(await allKbzRows(enrollmentId)).toHaveLength(0);
  });

  it("rejects an invalid reason", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_q_old");

    await expect(
      supersede(enrollmentId, tenantId, "KBZ_q_old", "NONSENSE", "KBZ_q_new"),
    ).rejects.toThrow(/invalid reason/i);
  });

  it.each(["FAILED", "EXPIRED", "SUPERSEDED"])("frees the slot for reason %s", async (reason) => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, `KBZ_r_${reason}_old`);

    const [r] = await supersede(
      enrollmentId,
      tenantId,
      `KBZ_r_${reason}_old`,
      reason,
      `KBZ_r_${reason}_new`,
    );

    expect(r.outcome).toBe("replaced");
    const rows = await allKbzRows(enrollmentId);
    expect(rows.find((x) => x.payment_ref === `KBZ_r_${reason}_old`)!.mmqr_status).toBe(reason);
    expect(await liveRows(enrollmentId)).toHaveLength(1);
  });

  // P1 review. The window here is WIDER than the claim's: between the two calls
  // the route makes one or two KBZPay round trips.
  it("returns invalid_enrollment and leaves the old row PENDING", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_s_old");
    await sql(`UPDATE enrollments SET status='rejected'::enrollment_status WHERE id=$1`, [
      enrollmentId,
    ]);

    const [r] = await supersede(enrollmentId, tenantId, "KBZ_s_old", "SUPERSEDED", "KBZ_s_new");

    expect(r.outcome).toBe("invalid_enrollment");
    const rows = await allKbzRows(enrollmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].mmqr_status).toBe("PENDING");
  });

  it("returns invalid_enrollment for a mismatched tenant", async () => {
    const { tenantId, enrollmentId } = await makeWorld();
    const other = await makeWorld();
    await seedLive(enrollmentId, tenantId, "KBZ_t_old");

    const [r] = await supersede(enrollmentId, other.tenantId, "KBZ_t_old", "SUPERSEDED", "KBZ_t_new");

    expect(r.outcome).toBe("invalid_enrollment");
    expect(await allKbzRows(enrollmentId)).toHaveLength(1);
  });
});
