import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { randomBytes, randomUUID } from "crypto";
import { DEFAULT_TICKET_TZ } from "@/lib/tickets/exp";

// ─── The leader's phone: buyer on the order, ticket_devices, bind, move ──────
// 20261122130000_leaders_phone.sql. Every new object is service-role only, so
// these tests call the functions as the superuser connection (the server calls
// them as service_role) and check an authenticated session gets nothing.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

let seq = 0;
const uniq = () => `lp${Date.now().toString(36)}${seq++}`;

/** A raw uncompressed P-256 point is 65 bytes: 87 base64url characters. */
const newKey = () => randomBytes(65).toString("base64url");

const tenants: string[] = [];
const authUsers: string[] = [];

// ── Fixture helpers ─────────────────────────────────────────────────────────

async function createTenant(): Promise<string> {
  const slug = uniq();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1, $2, 'event') RETURNING id`,
    [`Leaders phone ${slug}`, slug],
  );
  tenants.push(row.id);
  return row.id;
}

async function createIntake(
  tenantId: string,
  opts: { protection?: boolean; format?: "jwt" | "uuid" } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year, ticket_qr_format, ticket_protection)
     VALUES ($1, 'Leaders phone intake', 2026, $2, $3) RETURNING id`,
    [tenantId, opts.format ?? "jwt", opts.protection ?? false],
  );
  return row.id;
}

/** An open class; event_date is today in Yangon plus `days`. */
async function createClass(tenantId: string, intakeId: string, days = 10): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id, intake_id, level, fee_amount, seat_total, seat_remaining, status,
                          max_tickets_per_person, event_date)
     VALUES ($1, $2, $3, 100, 100, 100, 'open', 10,
             (now() AT TIME ZONE 'Asia/Yangon')::date + $4::int)
     RETURNING id`,
    [tenantId, intakeId, `L${uniq()}`, days],
  );
  return row.id;
}

async function newAuthUser(): Promise<string> {
  const id = randomUUID();
  await sql(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, `lp-${id}@example.test`]);
  authUsers.push(id);
  return id;
}

async function newBuyer(opts: { deleted?: boolean } = {}): Promise<string> {
  const id = await newAuthUser();
  await sql(
    `INSERT INTO buyer_profiles (id, email, deleted_at)
     VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END)`,
    [id, `buyer-${id}@example.test`, opts.deleted ?? false],
  );
  return id;
}

async function newStaff(tenantId: string, opts: { withProfile?: boolean } = {}): Promise<string> {
  const id = await newAuthUser();
  await sql(`INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, 'owner')`, [
    id,
    tenantId,
    `staff-${id}@example.test`,
  ]);
  if (opts.withProfile) {
    await sql(`INSERT INTO buyer_profiles (id, email) VALUES ($1, $2)`, [id, `staff-buyer-${id}@example.test`]);
  }
  return id;
}

/** An order on `classId` with `tickets` ticket rows. Confirmed by default. */
async function createOrder(opts: {
  tenantId: string;
  intakeId: string;
  classId: string;
  buyerId: string | null;
  status?: string;
  tickets?: number;
}): Promise<{ enrollmentId: string; ticketIds: string[] }> {
  const { tenantId, intakeId, classId, buyerId, status = "confirmed", tickets = 2 } = opts;
  const [e] = await sql<{ id: string }>(
    `INSERT INTO enrollments (enrollment_ref, tenant_id, student_name_en, phone, class_id, quantity, status, buyer_id)
     VALUES ('', $1, 'Leader Test', '09000000000', $2, $3, $4::enrollment_status, $5) RETURNING id`,
    [tenantId, classId, tickets, status, buyerId],
  );
  const ticketIds: string[] = [];
  for (let seat = 1; seat <= tickets; seat++) {
    const [t] = await sql<{ id: string }>(
      `INSERT INTO tickets (tenant_id, intake_id, enrollment_id, class_id, tier, seat_no, exp, kid)
       VALUES ($1, $2, $3, $4, 'General', $5, now() + interval '30 days', 'test-kid') RETURNING id`,
      [tenantId, intakeId, e.id, classId, seat],
    );
    ticketIds.push(t.id);
  }
  return { enrollmentId: e.id, ticketIds };
}

const bind = async (ticketId: string, tenantId: string, buyerId: string, key: string) =>
  (
    await sql<{ r: string }>(`SELECT public.bind_ticket_device($1, $2, $3, $4) AS r`, [
      ticketId,
      tenantId,
      buyerId,
      key,
    ])
  )[0].r;

const move = async (enrollmentId: string, tenantId: string, staffId: string, toBuyerId: string, reason: string) =>
  (
    await sql<{ result: string; from_buyer_id: string | null }>(
      `SELECT * FROM public.move_order_buyer($1, $2, $3, $4, $5)`,
      [enrollmentId, tenantId, staffId, toBuyerId, reason],
    )
  )[0];

const devices = async (ticketId: string) =>
  sql<{ buyer_id: string | null; public_key: string; revoked_at: Date | null; revoked_by: string | null }>(
    `SELECT buyer_id, public_key, revoked_at, revoked_by FROM public.ticket_devices
      WHERE ticket_id = $1 ORDER BY created_at, id`,
    [ticketId],
  );

const activeDevices = async (ticketId: string) => (await devices(ticketId)).filter((d) => !d.revoked_at);

const submitSingle = async (classId: string, key: string | null, buyerId: string | null) =>
  (
    await sql<{ r: Record<string, unknown> }>(
      `SELECT public.submit_enrollment($1::uuid, $2::text, 1, NULL::text, $3::uuid) AS r`,
      [classId, key, buyerId],
    )
  )[0].r;

const submitCart = async (items: { class_id: string; quantity: number }[], key: string | null, buyerId: string | null) =>
  (
    await sql<{ r: Record<string, unknown> }>(
      `SELECT public.submit_cart_enrollment($1::jsonb, NULL::uuid, NULL::text, $2::text, $3::uuid) AS r`,
      [JSON.stringify(items), key, buyerId],
    )
  )[0].r;

/** Wait until `pid` is blocked on a lock, so a race test really races. */
async function waitForLock(pid: number) {
  for (let i = 0; i < 100; i++) {
    const [row] = await sql<{ w: string | null }>(
      `SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (row?.w === "Lock") return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

// ── Shared fixtures ─────────────────────────────────────────────────────────

let T1 = "";
let T2 = "";
let protIntake = "";
let openIntake = "";
let protClass = "";
let openClass = "";
let B1 = "";
let B2 = "";
let S1 = "";
let order: { enrollmentId: string; ticketIds: string[] } = { enrollmentId: "", ticketIds: [] };

beforeAll(async () => {
  T1 = await createTenant();
  T2 = await createTenant();
  protIntake = await createIntake(T1, { protection: true });
  openIntake = await createIntake(T1);
  protClass = await createClass(T1, protIntake);
  openClass = await createClass(T1, openIntake);
  B1 = await newBuyer();
  B2 = await newBuyer();
  S1 = await newStaff(T1);
  order = await createOrder({ tenantId: T1, intakeId: protIntake, classId: protClass, buyerId: B1 });
});

afterAll(async () => {
  if (tenants.length) {
    // ticket_devices go with their tickets, order_moves with their orders.
    await sql(`DELETE FROM tickets WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await sql(`DELETE FROM order_moves WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await sql(`DELETE FROM enrollment_items WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await sql(`DELETE FROM enrollments WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await sql(`DELETE FROM classes WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await sql(`DELETE FROM intakes WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await sql(`DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  }
  // Profiles go with their auth user (ON DELETE CASCADE).
  if (authUsers.length) await sql(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [authUsers]);
  await pool.end();
});

// ── 1–2. The protection switch ──────────────────────────────────────────────

describe("intakes.ticket_protection", () => {
  it("1. is locked once the intake has an order (single or cart); free on a fresh intake", async () => {
    await expect(
      sql(`UPDATE intakes SET ticket_protection = false WHERE id = $1`, [protIntake]),
    ).rejects.toThrow(/ticket_protection_locked/);

    // A cart order reaches its classes only through enrollment_items.
    const cartIntake = await createIntake(T1);
    const cartClass = await createClass(T1, cartIntake);
    const [e] = await sql<{ id: string }>(
      `INSERT INTO enrollments (enrollment_ref, tenant_id, student_name_en, phone, class_id, quantity, status)
       VALUES ('', $1, 'Cart Test', '09000000000', NULL, 1, 'pending_payment') RETURNING id`,
      [T1],
    );
    await sql(
      `INSERT INTO enrollment_items (enrollment_id, class_id, tenant_id, fee_amount, quantity)
       VALUES ($1, $2, $3, 100, 1)`,
      [e.id, cartClass, T1],
    );
    await expect(
      sql(`UPDATE intakes SET ticket_protection = true WHERE id = $1`, [cartIntake]),
    ).rejects.toThrow(/ticket_protection_locked/);

    const fresh = await createIntake(T1);
    await sql(`UPDATE intakes SET ticket_protection = true WHERE id = $1`, [fresh]);
    const [row] = await sql<{ p: boolean }>(`SELECT ticket_protection AS p FROM intakes WHERE id = $1`, [fresh]);
    expect(row.p).toBe(true);
  });

  it("2. can't be on for a uuid intake (23514)", async () => {
    await expect(createIntake(T1, { protection: true, format: "uuid" })).rejects.toMatchObject({
      code: "23514",
      constraint: "intakes_ticket_protection_needs_jwt",
    });
  });
});

// ── 3–5. The submit RPCs ────────────────────────────────────────────────────

describe("submit RPCs and p_buyer_id", () => {
  it("3. submit_enrollment on a protected class: buyer required, buyer stored, key bound to the buyer", async () => {
    const key = `lp-${randomUUID()}`;
    const byKey = async () =>
      sql<{ id: string; buyer_id: string | null; email: string | null }>(
        `SELECT id, buyer_id, email FROM enrollments WHERE idempotency_key = $1`,
        [key],
      );

    const none = await submitSingle(protClass, key, null);
    expect(none).toMatchObject({ success: false, error: "BUYER_REQUIRED" });
    expect(await byKey()).toHaveLength(0);

    const ok = await submitSingle(protClass, key, B1);
    expect(ok).toMatchObject({ success: true });
    const [row] = await byKey();
    expect(row.id).toBe(ok.enrollment_id);
    expect(row.buyer_id).toBe(B1);
    expect(row.email).toBe(`buyer-${B1}@example.test`);

    expect(await submitSingle(protClass, key, B2)).toMatchObject({
      success: false,
      error: "IDEMPOTENCY_CONFLICT",
    });

    const replay = await submitSingle(protClass, key, B1);
    expect(replay).toMatchObject({ success: true, enrollment_id: ok.enrollment_id });
    expect(await byKey()).toHaveLength(1);
  });

  it("4. submit_cart_enrollment with one protected and one unprotected item and no buyer: BUYER_REQUIRED", async () => {
    const key = `lp-${randomUUID()}`;
    const r = await submitCart(
      [
        { class_id: openClass, quantity: 1 },
        { class_id: protClass, quantity: 1 },
      ],
      key,
      null,
    );
    expect(r).toMatchObject({ success: false, error: "BUYER_REQUIRED" });
    expect(await sql(`SELECT 1 FROM enrollments WHERE idempotency_key = $1`, [key])).toHaveLength(0);
  });

  it("4b. regression: unprotected single and cart orders with no buyer succeed as before", async () => {
    const single = await submitSingle(openClass, `lp-${randomUUID()}`, null);
    expect(single).toMatchObject({ success: true });

    const cartKey = `lp-${randomUUID()}`;
    const cart = await submitCart([{ class_id: openClass, quantity: 2 }], cartKey, null);
    expect(cart).toMatchObject({ success: true, quantity: 2 });

    // A guest cart replay still replays.
    const replay = await submitCart([{ class_id: openClass, quantity: 2 }], cartKey, null);
    expect(replay).toMatchObject({ success: true, enrollment_id: cart.enrollment_id });

    const rows = await sql<{ buyer_id: string | null; email: string | null }>(
      `SELECT buyer_id, email FROM enrollments WHERE id = ANY($1::uuid[])`,
      [[single.enrollment_id, cart.enrollment_id]],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.buyer_id).toBeNull();
      expect(r.email).toBeNull();
    }
  });

  it("5. a buyer whose profile is deleted: BUYER_REQUIRED", async () => {
    const gone = await newBuyer({ deleted: true });
    expect(await submitSingle(protClass, `lp-${randomUUID()}`, gone)).toMatchObject({
      success: false,
      error: "BUYER_REQUIRED",
    });
    // The same on an unprotected class: a buyer id always needs a live profile.
    expect(await submitSingle(openClass, `lp-${randomUUID()}`, gone)).toMatchObject({
      success: false,
      error: "BUYER_REQUIRED",
    });
  });
});

// ── 6–8b. Binding ───────────────────────────────────────────────────────────

describe("bind_ticket_device", () => {
  it("6. first bind, the same key, a new key, and 20 rebinds leave one active row", async () => {
    const [ticket] = order.ticketIds;
    const a = newKey();
    const b = newKey();
    expect(await bind(ticket, T1, B1, a)).toBe("bound_first");
    expect(await bind(ticket, T1, B1, a)).toBe("unchanged");
    expect(await bind(ticket, T1, B1, b)).toBe("bound_again");

    const active = await activeDevices(ticket);
    expect(active).toHaveLength(1);
    expect(active[0].public_key).toBe(b);
    const first = (await devices(ticket)).find((d) => d.public_key === a)!;
    expect(first.revoked_at).not.toBeNull();
    expect(first.revoked_by).toBe("rebind");

    for (let i = 0; i < 20; i++) {
      expect(await bind(ticket, T1, B1, newKey())).toBe("bound_again");
    }
    expect(await activeDevices(ticket)).toHaveLength(1);
    expect(await devices(ticket)).toHaveLength(22);
  });

  it("7. refuses another buyer, another tenant, a void ticket, an unprotected ticket, an unconfirmed order, a malformed key", async () => {
    const [, ticket] = order.ticketIds;
    expect(await bind(ticket, T1, B2, newKey())).toBe("refused");
    expect(await bind(ticket, T2, B1, newKey())).toBe("refused");
    expect(newKey().slice(0, 86)).toHaveLength(86);
    expect(await bind(ticket, T1, B1, newKey().slice(0, 86))).toBe("refused");

    const voided = await createOrder({ tenantId: T1, intakeId: protIntake, classId: protClass, buyerId: B1, tickets: 1 });
    await sql(`UPDATE tickets SET status = 'void' WHERE id = $1`, [voided.ticketIds[0]]);
    expect(await bind(voided.ticketIds[0], T1, B1, newKey())).toBe("refused");

    const open = await createOrder({ tenantId: T1, intakeId: openIntake, classId: openClass, buyerId: B1, tickets: 1 });
    expect(await bind(open.ticketIds[0], T1, B1, newKey())).toBe("refused");

    const pending = await createOrder({
      tenantId: T1,
      intakeId: protIntake,
      classId: protClass,
      buyerId: B1,
      status: "pending_payment",
      tickets: 1,
    });
    expect(await bind(pending.ticketIds[0], T1, B1, newKey())).toBe("refused");

    for (const t of [ticket, voided.ticketIds[0], open.ticketIds[0], pending.ticketIds[0]]) {
      expect(await devices(t)).toHaveLength(0);
    }
  });

  it("8. two concurrent binds leave exactly one active row", async () => {
    const fresh = await createOrder({ tenantId: T1, intakeId: protIntake, classId: protClass, buyerId: B1, tickets: 1 });
    const ticket = fresh.ticketIds[0];
    const a = newKey();
    const b = newKey();

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query("BEGIN");
      const r1 = await c1.query(`SELECT public.bind_ticket_device($1, $2, $3, $4) AS r`, [ticket, T1, B1, a]);
      expect(r1.rows[0].r).toBe("bound_first");

      const pid = (await c2.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      // Not awaited: blocks on client 1's ticket lock.
      const pending = c2.query(`SELECT public.bind_ticket_device($1, $2, $3, $4) AS r`, [ticket, T1, B1, b]);
      pending.catch(() => {});
      expect(await waitForLock(pid)).toBe(true);
      await c1.query("COMMIT");

      expect((await pending).rows[0].r).toBe("bound_again");
      const active = await activeDevices(ticket);
      expect(active).toHaveLength(1);
      expect(active[0].public_key).toBe(b);
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c1.end();
      await c2.end();
    }
  });

  it("8b. a bind queued behind a move reads the new buyer and is refused", async () => {
    const fresh = await createOrder({ tenantId: T1, intakeId: protIntake, classId: protClass, buyerId: B1, tickets: 1 });
    const ticket = fresh.ticketIds[0];

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query("BEGIN");
      const moved = await c1.query(`SELECT * FROM public.move_order_buyer($1, $2, $3, $4, $5)`, [
        fresh.enrollmentId,
        T1,
        S1,
        B2,
        "race test",
      ]);
      expect(moved.rows[0]).toMatchObject({ result: "moved", from_buyer_id: B1 });

      const pid = (await c2.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const pending = c2.query(`SELECT public.bind_ticket_device($1, $2, $3, $4) AS r`, [ticket, T1, B1, newKey()]);
      pending.catch(() => {});
      expect(await waitForLock(pid)).toBe(true);
      await c1.query("COMMIT");

      expect((await pending).rows[0].r).toBe("refused");
      expect((await activeDevices(ticket)).filter((d) => d.buyer_id === B1)).toHaveLength(0);
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c1.end();
      await c2.end();
    }
  });
});

// ── 9–10. Moving an order ───────────────────────────────────────────────────

describe("move_order_buyer", () => {
  it("9. moves the order, revokes every phone, records the move; the old buyer can't bind, the new one can", async () => {
    const o = await createOrder({ tenantId: T1, intakeId: protIntake, classId: protClass, buyerId: B1 });
    for (const t of o.ticketIds) expect(await bind(t, T1, B1, newKey())).toBe("bound_first");

    expect(await move(o.enrollmentId, T1, S1, B2, "lost mailbox")).toEqual({ result: "moved", from_buyer_id: B1 });

    const [e] = await sql<{ buyer_id: string }>(`SELECT buyer_id FROM enrollments WHERE id = $1`, [o.enrollmentId]);
    expect(e.buyer_id).toBe(B2);

    for (const t of o.ticketIds) {
      expect(await activeDevices(t)).toHaveLength(0);
      const all = await devices(t);
      expect(all).toHaveLength(1);
      expect(all[0].revoked_by).toBe("order_moved");
    }

    const moves = await sql<{ from_buyer_id: string; to_buyer_id: string; moved_by: string; reason: string }>(
      `SELECT from_buyer_id, to_buyer_id, moved_by, reason FROM order_moves WHERE enrollment_id = $1`,
      [o.enrollmentId],
    );
    expect(moves).toEqual([{ from_buyer_id: B1, to_buyer_id: B2, moved_by: S1, reason: "lost mailbox" }]);

    expect(await bind(o.ticketIds[0], T1, B1, newKey())).toBe("refused");
    expect(await bind(o.ticketIds[0], T1, B2, newKey())).toBe("bound_first");
  });

  it("10. refuses, changing nothing, for each bad request", async () => {
    const o = await createOrder({ tenantId: T1, intakeId: protIntake, classId: protClass, buyerId: B1, tickets: 1 });
    const key = newKey();
    expect(await bind(o.ticketIds[0], T1, B1, key)).toBe("bound_first");

    const staffBuyer = await newStaff(T1, { withProfile: true });
    const noProfile = await newAuthUser();
    const deletedProfile = await newBuyer({ deleted: true });
    const T2staff = await newStaff(T2);

    const unconfirmed = await createOrder({
      tenantId: T1,
      intakeId: protIntake,
      classId: protClass,
      buyerId: B1,
      status: "payment_submitted",
      tickets: 1,
    });
    const guest = await createOrder({ tenantId: T1, intakeId: protIntake, classId: protClass, buyerId: null, tickets: 1 });
    const endedIntake = await createIntake(T1, { protection: true });
    const endedClass = await createClass(T1, endedIntake, -1);
    const ended = await createOrder({
      tenantId: T1,
      intakeId: endedIntake,
      classId: endedClass,
      buyerId: B1,
      tickets: 1,
    });

    const refusals: [string, string, string, string, string, string][] = [
      ["tenant T2", o.enrollmentId, T2, S1, B2, "reason"],
      ["an unconfirmed order", unconfirmed.enrollmentId, T1, S1, B2, "reason"],
      ["an order with no buyer", guest.enrollmentId, T1, S1, B2, "reason"],
      ["a target that is staff", o.enrollmentId, T1, S1, staffBuyer, "reason"],
      ["a target with no profile", o.enrollmentId, T1, S1, noProfile, "reason"],
      ["a target whose profile is deleted", o.enrollmentId, T1, S1, deletedProfile, "reason"],
      ["the current buyer", o.enrollmentId, T1, S1, B1, "reason"],
      ["staff of another tenant", o.enrollmentId, T1, T2staff, B2, "reason"],
      ["an event that ended yesterday", ended.enrollmentId, T1, S1, B2, "reason"],
      ["an empty reason", o.enrollmentId, T1, S1, B2, "   "],
    ];
    for (const [label, enrollmentId, tenantId, staffId, toBuyer, reason] of refusals) {
      expect({ label, ...(await move(enrollmentId, tenantId, staffId, toBuyer, reason)) }).toEqual({
        label,
        result: "refused",
        from_buyer_id: null,
      });
    }

    const ids = [o, unconfirmed, guest, ended].map((x) => x.enrollmentId);
    const rows = await sql<{ id: string; buyer_id: string | null }>(
      `SELECT id, buyer_id FROM enrollments WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.buyer_id]))).toEqual({
      [o.enrollmentId]: B1,
      [unconfirmed.enrollmentId]: B1,
      [guest.enrollmentId]: null,
      [ended.enrollmentId]: B1,
    });
    expect(await sql(`SELECT 1 FROM order_moves WHERE enrollment_id = ANY($1::uuid[])`, [ids])).toHaveLength(0);
    const active = await activeDevices(o.ticketIds[0]);
    expect(active).toHaveLength(1);
    expect(active[0].public_key).toBe(key);
  });
});

// ── 11. Account deletion step ───────────────────────────────────────────────

describe("revoke_buyer_ticket_devices", () => {
  it("11. revokes every active phone of the buyer with account_deleted; a second call returns 0", async () => {
    const buyer = await newBuyer();
    const o = await createOrder({ tenantId: T1, intakeId: protIntake, classId: protClass, buyerId: buyer });
    for (const t of o.ticketIds) expect(await bind(t, T1, buyer, newKey())).toBe("bound_first");
    // A rebind leaves an already-revoked row, which must not be counted.
    expect(await bind(o.ticketIds[0], T1, buyer, newKey())).toBe("bound_again");

    const revoke = async () =>
      (await sql<{ n: number }>(`SELECT public.revoke_buyer_ticket_devices($1) AS n`, [buyer]))[0].n;
    expect(await revoke()).toBe(2);
    for (const t of o.ticketIds) {
      expect(await activeDevices(t)).toHaveLength(0);
    }
    const reasons = await sql<{ revoked_by: string; n: number }>(
      `SELECT revoked_by, count(*)::int AS n FROM ticket_devices
        WHERE ticket_id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`,
      [o.ticketIds],
    );
    expect(reasons).toEqual([
      { revoked_by: "account_deleted", n: 2 },
      { revoked_by: "rebind", n: 1 },
    ]);
    expect(await revoke()).toBe(0);
  });
});

// ── 12. Authenticated sessions get nothing ──────────────────────────────────

describe("authenticated sessions get nothing", () => {
  async function runAs(text: string, params: unknown[] = []) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: B1, role: "authenticated" }),
      ]);
      const res = await client.query(text, params);
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  }

  it.each([
    ["submit_enrollment", `SELECT public.submit_enrollment($1::uuid, NULL, 1, NULL, NULL)`, () => [protClass]],
    [
      "submit_cart_enrollment",
      `SELECT public.submit_cart_enrollment($1::jsonb, NULL, NULL, NULL, NULL)`,
      () => [JSON.stringify([{ class_id: protClass, quantity: 1 }])],
    ],
    [
      "bind_ticket_device",
      `SELECT public.bind_ticket_device($1, $2, $3, $4)`,
      () => [order.ticketIds[0], T1, B1, newKey()],
    ],
    [
      "move_order_buyer",
      `SELECT * FROM public.move_order_buyer($1, $2, $3, $4, 'x')`,
      () => [order.enrollmentId, T1, S1, B2],
    ],
    ["revoke_buyer_ticket_devices", `SELECT public.revoke_buyer_ticket_devices($1)`, () => [B1]],
  ])("12. cannot run %s (42501)", async (_name, text, params) => {
    await expect(runAs(text, params())).rejects.toMatchObject({ code: "42501" });
  });

  // Locally setup.ts re-grants table DML to authenticated, so RLS (no
  // policies) is what refuses here. The REVOKE itself is proven on the dev
  // database (plan Task 9 step 4.2), not locally.
  it.each(["ticket_devices", "order_moves"])("12. sees zero rows of %s", async (table) => {
    const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
    expect(n).toBeGreaterThan(0);
    expect((await runAs(`SELECT * FROM public.${table}`)).rowCount).toBe(0);
  });
});

// ── 13–14. Time zone and service_role table privileges ──────────────────────

describe("move_order_buyer's time zone and service_role's table privileges", () => {
  it("13. the zone in move_order_buyer equals the app's TICKET_TZ default", async () => {
    const [{ src }] = await sql<{ src: string }>(
      `SELECT replace(prosrc, chr(13), '') AS src FROM pg_proc
        WHERE oid = 'public.move_order_buyer(uuid,uuid,uuid,uuid,text)'::regprocedure`,
    );
    const zones = [...src.matchAll(/AT TIME ZONE '([^']+)'/g)].map((m) => m[1]);
    expect(zones).toEqual([DEFAULT_TICKET_TZ]);
  });

  // setup.ts grants SELECT/INSERT/UPDATE/DELETE on every table to service_role,
  // so DELETE (and UPDATE on order_moves) can't be checked locally: that is the
  // dev-DB check in plan Task 9 step 4.2. What setup doesn't touch is the rest
  // of "REVOKE ALL ... FROM service_role": TRUNCATE, REFERENCES and TRIGGER.
  it.each(["ticket_devices", "order_moves"])("14. service_role has no TRUNCATE, REFERENCES or TRIGGER on %s", async (table) => {
    const [row] = await sql<{ t: boolean; r: boolean; g: boolean }>(
      `SELECT has_table_privilege('service_role', $1, 'TRUNCATE') AS t,
              has_table_privilege('service_role', $1, 'REFERENCES') AS r,
              has_table_privilege('service_role', $1, 'TRIGGER') AS g`,
      [`public.${table}`],
    );
    expect(row).toEqual({ t: false, r: false, g: false });
  });
});
