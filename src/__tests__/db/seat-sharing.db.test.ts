import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { randomBytes, randomUUID } from "crypto";
import { DEFAULT_TICKET_TZ } from "@/lib/tickets/exp";

// ─── Seat sharing (mode B): holder, share links, holder history ─────────────
// 20261123120000_seat_sharing.sql (design 6.4, Plan 4 Task 1). Every new object
// is service-role only, so these tests call the functions as the superuser
// connection (the server calls them as service_role) and check an
// authenticated session gets nothing. Fixture helpers copied from
// leaders-phone.db.test.ts.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

let seq = 0;
const uniq = () => `ss${Date.now().toString(36)}${seq++}`;

/** A raw uncompressed P-256 point is 65 bytes: 87 base64url characters. */
const newKey = () => randomBytes(65).toString("base64url");

const tenants: string[] = [];
const authUsers: string[] = [];

// ── Fixture helpers (from leaders-phone.db.test.ts) ─────────────────────────

async function createTenant(): Promise<string> {
  const slug = uniq();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1, $2, 'event') RETURNING id`,
    [`Seat sharing ${slug}`, slug],
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
     VALUES ($1, 'Seat sharing intake', 2026, $2, $3) RETURNING id`,
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
  await sql(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, `ss-${id}@example.test`]);
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

// ── Sharing helpers (plan Task 1 step 1) ────────────────────────────────────

const hash = () => randomBytes(32).toString("hex"); // stands in for sha256(token) as hex
const call = async <T>(q: string, p: unknown[]) => (await sql<T>(q, p))[0];
const create = (t: string, ten: string, leader: string, h: string) =>
  call<{ result: string; expires_at: Date | null }>(`SELECT * FROM public.create_share_link($1,$2,$3,$4)`, [
    t,
    ten,
    leader,
    h,
  ]);
const cancel = (t: string, ten: string, leader: string) =>
  call<{ r: string }>(`SELECT public.cancel_share_link($1,$2,$3) AS r`, [t, ten, leader]);
const claim = (h: string, ten: string, who: string) =>
  call<{ result: string; ticket_id: string | null; leader_id: string | null }>(
    `SELECT * FROM public.claim_share_link($1,$2,$3)`,
    [h, ten, who],
  );
const giveBack = (t: string, ten: string, who: string) =>
  call<{ result: string; leader_id: string | null }>(`SELECT * FROM public.give_back_seat($1,$2,$3)`, [t, ten, who]);
const preview = (h: string, ten: string, who: string) =>
  sql<{ event_name: string; tier: string; seat_no: number; event_date: Date }>(
    `SELECT * FROM public.preview_share_link($1,$2,$3)`,
    [h, ten, who],
  );
const voidOrder = async (e: string) =>
  (await call<{ n: number }>(`SELECT public.void_enrollment_tickets($1) AS n`, [e])).n;
const revoke = async (b: string) =>
  (await call<{ n: number }>(`SELECT public.revoke_buyer_ticket_devices($1) AS n`, [b])).n;
const events = (t: string) =>
  sql<{
    event: string;
    actor_buyer_id: string | null;
    actor_staff_id: string | null;
    from_buyer_id: string | null;
    to_buyer_id: string | null;
  }>(
    `SELECT event, actor_buyer_id, actor_staff_id, from_buyer_id, to_buyer_id FROM public.ticket_holder_events WHERE ticket_id = $1 ORDER BY created_at, id`,
    [t],
  );
const holder = async (t: string) =>
  (await call<{ h: string | null }>(`SELECT holder_buyer_id AS h FROM tickets WHERE id = $1`, [t])).h;
const links = (t: string) =>
  sql<{
    token_hash: string;
    claimed_by: string | null;
    claimed_at: Date | null;
    cancelled_at: Date | null;
    expires_at: Date | null;
  }>(
    `SELECT token_hash, claimed_by, claimed_at, cancelled_at, expires_at FROM public.ticket_share_links
      WHERE ticket_id = $1 ORDER BY created_at, id`,
    [t],
  );
const openLinks = async (t: string) => (await links(t)).filter((l) => !l.claimed_at && !l.cancelled_at);
const setToday = (classId: string) =>
  sql(`UPDATE classes SET event_date = (now() AT TIME ZONE 'Asia/Yangon')::date WHERE id = $1`, [classId]);

// ── Shared fixtures ─────────────────────────────────────────────────────────

let T1 = "";
let T2 = "";
let protIntake = "";
let openIntake = "";
let S1 = "";

beforeAll(async () => {
  T1 = await createTenant();
  T2 = await createTenant();
  protIntake = await createIntake(T1, { protection: true });
  openIntake = await createIntake(T1);
  S1 = await newStaff(T1);
});

afterAll(async () => {
  if (tenants.length) {
    // ticket_devices, ticket_share_links and ticket_holder_events go with their tickets.
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

type Seat = { leader: string; classId: string; enrollmentId: string; ticketIds: string[]; ticket: string };

/** A fresh leader and order on its own protected class (`days` from today). */
async function seat(opts: { days?: number; tickets?: number; status?: string; intake?: string } = {}): Promise<Seat> {
  const intake = opts.intake ?? protIntake;
  const leader = await newBuyer();
  const classId = await createClass(T1, intake, opts.days ?? 10);
  const o = await createOrder({
    tenantId: T1,
    intakeId: intake,
    classId,
    buyerId: leader,
    status: opts.status,
    tickets: opts.tickets ?? 1,
  });
  return { leader, classId, ...o, ticket: o.ticketIds[0] };
}

/** A seat with an open link the leader made. */
async function sharedSeat(opts: { tickets?: number } = {}): Promise<Seat & { hash: string }> {
  const s = await seat(opts);
  const h = hash();
  expect((await create(s.ticket, T1, s.leader, h)).result).toBe("created");
  return { ...s, hash: h };
}

/** A seat a friend claimed. */
async function claimedSeat(opts: { tickets?: number } = {}): Promise<Seat & { hash: string; friend: string }> {
  const s = await sharedSeat(opts);
  const friend = await newBuyer();
  expect((await claim(s.hash, T1, friend)).result).toBe("claimed");
  return { ...s, friend };
}

/** Every case of test 5: a claim (and a preview) that must be refused. */
async function claimRefusals(): Promise<{ label: string; hash: string; tenant: string; claimer: string; ticket: string }[]> {
  const out: { label: string; hash: string; tenant: string; claimer: string; ticket: string }[] = [];

  const own = await sharedSeat();
  out.push({ label: "the leader's own link", hash: own.hash, tenant: T1, claimer: own.leader, ticket: own.ticket });

  const used = await claimedSeat();
  out.push({ label: "a claimed link", hash: used.hash, tenant: T1, claimer: await newBuyer(), ticket: used.ticket });

  const cancelled = await sharedSeat();
  expect((await cancel(cancelled.ticket, T1, cancelled.leader)).r).toBe("cancelled");
  out.push({ label: "a cancelled link", hash: cancelled.hash, tenant: T1, claimer: await newBuyer(), ticket: cancelled.ticket });

  const replaced = await sharedSeat();
  expect((await create(replaced.ticket, T1, replaced.leader, hash())).result).toBe("created");
  out.push({ label: "a replaced link", hash: replaced.hash, tenant: T1, claimer: await newBuyer(), ticket: replaced.ticket });

  const any = await sharedSeat();
  out.push({ label: "an unknown hash", hash: hash(), tenant: T1, claimer: await newBuyer(), ticket: any.ticket });
  out.push({ label: "tenant T2", hash: any.hash, tenant: T2, claimer: await newBuyer(), ticket: any.ticket });

  const late = await sharedSeat();
  await setToday(late.classId);
  out.push({ label: "past the cutoff (recomputed)", hash: late.hash, tenant: T1, claimer: await newBuyer(), ticket: late.ticket });

  const staff = await sharedSeat();
  out.push({
    label: "a staff account",
    hash: staff.hash,
    tenant: T1,
    claimer: await newStaff(T1, { withProfile: true }),
    ticket: staff.ticket,
  });

  const deleted = await sharedSeat();
  out.push({
    label: "a deleted profile",
    hash: deleted.hash,
    tenant: T1,
    claimer: await newBuyer({ deleted: true }),
    ticket: deleted.ticket,
  });

  const voided = await sharedSeat();
  await sql(`UPDATE tickets SET status = 'void' WHERE id = $1`, [voided.ticket]);
  out.push({ label: "a void seat", hash: voided.hash, tenant: T1, claimer: await newBuyer(), ticket: voided.ticket });

  const admitted = await sharedSeat();
  await sql(`UPDATE tickets SET first_scan_at = now() WHERE id = $1`, [admitted.ticket]);
  out.push({ label: "an admitted seat", hash: admitted.hash, tenant: T1, claimer: await newBuyer(), ticket: admitted.ticket });

  return out;
}

// ── 1–2. create_share_link ──────────────────────────────────────────────────

describe("create_share_link", () => {
  it("1. creates a link that expires at the cutoff; a second create replaces it", async () => {
    const s = await seat();
    const h1 = hash();
    const r = await create(s.ticket, T1, s.leader, h1);
    const [{ c }] = await sql<{ c: Date }>(
      `SELECT public.share_cutoff(event_date) AS c FROM classes WHERE id = $1`,
      [s.classId],
    );
    expect(r.result).toBe("created");
    expect(r.expires_at).toEqual(c);
    expect(await openLinks(s.ticket)).toHaveLength(1);
    expect((await openLinks(s.ticket))[0]).toMatchObject({ token_hash: h1, expires_at: c });
    expect(await events(s.ticket)).toEqual([
      { event: "link_created", actor_buyer_id: s.leader, actor_staff_id: null, from_buyer_id: s.leader, to_buyer_id: null },
    ]);

    const h2 = hash();
    expect((await create(s.ticket, T1, s.leader, h2)).result).toBe("created");
    const all = await links(s.ticket);
    expect(all).toHaveLength(2);
    expect(all[0].token_hash).toBe(h1);
    expect(all[0].cancelled_at).not.toBeNull();
    const open = await openLinks(s.ticket);
    expect(open).toHaveLength(1);
    expect(open[0].token_hash).toBe(h2);
    // Plan decision 7: a replace logs only link_created.
    expect((await events(s.ticket)).map((e) => e.event)).toEqual(["link_created", "link_created"]);
  });

  it("2. refuses each bad request and writes no link", async () => {
    const base = await seat();
    const other = await newBuyer();
    const claimed = await claimedSeat();
    const unprotected = await seat({ intake: openIntake });
    const voided = await seat();
    await sql(`UPDATE tickets SET status = 'void' WHERE id = $1`, [voided.ticket]);
    const admitted = await seat();
    await sql(`UPDATE tickets SET first_scan_at = now() WHERE id = $1`, [admitted.ticket]);
    const unconfirmed = await seat({ status: "pending_payment" });
    const today = await seat({ days: 0 });
    const tomorrow = await seat({ days: 1 });
    const noDate = await seat();
    await sql(`UPDATE classes SET event_date = NULL WHERE id = $1`, [noDate.classId]);
    const deletedLeader = await seat();
    await sql(`UPDATE buyer_profiles SET deleted_at = now() WHERE id = $1`, [deletedLeader.leader]);

    const cases: [string, string, string, string, string][] = [
      ["another buyer", base.ticket, T1, other, hash()],
      ["a friend who holds the seat", claimed.ticket, T1, claimed.friend, hash()],
      ["a seat already claimed", claimed.ticket, T1, claimed.leader, hash()],
      ["another tenant", base.ticket, T2, base.leader, hash()],
      ["an unprotected intake", unprotected.ticket, T1, unprotected.leader, hash()],
      ["a void ticket", voided.ticket, T1, voided.leader, hash()],
      ["an admitted seat", admitted.ticket, T1, admitted.leader, hash()],
      ["an unconfirmed order", unconfirmed.ticket, T1, unconfirmed.leader, hash()],
      ["days = 0", today.ticket, T1, today.leader, hash()],
      ["days = 1", tomorrow.ticket, T1, tomorrow.leader, hash()],
      ["event_date NULL", noDate.ticket, T1, noDate.leader, hash()],
      ["a malformed hash (short)", base.ticket, T1, base.leader, "abc"],
      ["a malformed hash (upper case)", base.ticket, T1, base.leader, hash().toUpperCase()],
      ["a leader whose profile is deleted", deletedLeader.ticket, T1, deletedLeader.leader, hash()],
    ];
    for (const [label, t, ten, who, h] of cases) {
      const before = (await links(t)).length;
      expect({ label, ...(await create(t, ten, who, h)) }).toEqual({ label, result: "refused", expires_at: null });
      expect({ label, n: (await links(t)).length }).toEqual({ label, n: before });
    }
  });
});

// ── 3. cancel_share_link ────────────────────────────────────────────────────

describe("cancel_share_link", () => {
  it("3. cancels and logs; a second call is 'none'; works after the cutoff and on a void seat; refuses others", async () => {
    const s = await sharedSeat();
    expect((await cancel(s.ticket, T1, await newBuyer())).r).toBe("refused");
    expect((await cancel(s.ticket, T2, s.leader)).r).toBe("refused");
    expect(await openLinks(s.ticket)).toHaveLength(1);

    expect((await cancel(s.ticket, T1, s.leader)).r).toBe("cancelled");
    expect(await openLinks(s.ticket)).toHaveLength(0);
    expect(await events(s.ticket)).toEqual([
      { event: "link_created", actor_buyer_id: s.leader, actor_staff_id: null, from_buyer_id: s.leader, to_buyer_id: null },
      { event: "link_cancelled", actor_buyer_id: s.leader, actor_staff_id: null, from_buyer_id: s.leader, to_buyer_id: null },
    ]);
    expect((await cancel(s.ticket, T1, s.leader)).r).toBe("none");
    expect(await events(s.ticket)).toHaveLength(2);

    const late = await sharedSeat();
    await setToday(late.classId);
    expect((await cancel(late.ticket, T1, late.leader)).r).toBe("cancelled");

    const voided = await sharedSeat();
    await sql(`UPDATE tickets SET status = 'void' WHERE id = $1`, [voided.ticket]);
    expect((await cancel(voided.ticket, T1, voided.leader)).r).toBe("cancelled");
  });
});

// ── 4–7. claim_share_link ───────────────────────────────────────────────────

describe("claim_share_link", () => {
  it("4. claims: holder set, link marked, the leader's phone revoked, one claimed event", async () => {
    const s = await seat();
    expect(await bind(s.ticket, T1, s.leader, newKey())).toBe("bound_first");
    const h = hash();
    expect((await create(s.ticket, T1, s.leader, h)).result).toBe("created");
    const friend = await newBuyer();

    expect(await claim(h, T1, friend)).toEqual({ result: "claimed", ticket_id: s.ticket, leader_id: s.leader });
    expect(await holder(s.ticket)).toBe(friend);
    const [l] = await links(s.ticket);
    expect(l.claimed_by).toBe(friend);
    expect(l.claimed_at).not.toBeNull();
    expect(l.cancelled_at).toBeNull();

    expect(await activeDevices(s.ticket)).toHaveLength(0);
    const [d] = await devices(s.ticket);
    expect(d).toMatchObject({ buyer_id: s.leader, revoked_by: "holder_changed" });

    const claimed = (await events(s.ticket)).filter((e) => e.event === "claimed");
    expect(claimed).toEqual([
      { event: "claimed", actor_buyer_id: friend, actor_staff_id: null, from_buyer_id: s.leader, to_buyer_id: friend },
    ]);
  });

  it("5. refuses every bad claim and changes nothing", async () => {
    for (const c of await claimRefusals()) {
      const holderBefore = await holder(c.ticket);
      const linksBefore = await links(c.ticket);
      const eventsBefore = await events(c.ticket);
      expect({ label: c.label, ...(await claim(c.hash, c.tenant, c.claimer)) }).toEqual({
        label: c.label,
        result: "refused",
        ticket_id: null,
        leader_id: null,
      });
      expect({ label: c.label, h: await holder(c.ticket) }).toEqual({ label: c.label, h: holderBefore });
      expect({ label: c.label, l: await links(c.ticket) }).toEqual({ label: c.label, l: linksBefore });
      expect({ label: c.label, e: await events(c.ticket) }).toEqual({ label: c.label, e: eventsBefore });
    }
  });

  it("6. two concurrent claims of one link: exactly one wins", async () => {
    const s = await sharedSeat();
    const f1 = await newBuyer();
    const f2 = await newBuyer();

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query("BEGIN");
      const r1 = await c1.query(`SELECT * FROM public.claim_share_link($1,$2,$3)`, [s.hash, T1, f1]);
      expect(r1.rows[0].result).toBe("claimed");

      const pid = (await c2.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const pending = c2.query(`SELECT * FROM public.claim_share_link($1,$2,$3)`, [s.hash, T1, f2]);
      pending.catch(() => {});
      expect(await waitForLock(pid)).toBe(true);
      await c1.query("COMMIT");

      expect((await pending).rows[0].result).toBe("refused");
      expect(await holder(s.ticket)).toBe(f1);
      expect((await events(s.ticket)).filter((e) => e.event === "claimed")).toHaveLength(1);
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c1.end();
      await c2.end();
    }
  });

  it("7. a claim queued behind the leader's bind revokes that bind; then only the friend can bind", async () => {
    const s = await sharedSeat();
    const friend = await newBuyer();
    const leaderKey = newKey();

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query("BEGIN");
      const r1 = await c1.query(`SELECT public.bind_ticket_device($1,$2,$3,$4) AS r`, [s.ticket, T1, s.leader, leaderKey]);
      expect(r1.rows[0].r).toBe("bound_first");

      const pid = (await c2.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const pending = c2.query(`SELECT * FROM public.claim_share_link($1,$2,$3)`, [s.hash, T1, friend]);
      pending.catch(() => {});
      expect(await waitForLock(pid)).toBe(true);
      await c1.query("COMMIT");

      expect((await pending).rows[0].result).toBe("claimed");
      const leaderRow = (await devices(s.ticket)).find((d) => d.public_key === leaderKey)!;
      expect(leaderRow.revoked_by).toBe("holder_changed");
      expect(await activeDevices(s.ticket)).toHaveLength(0);
      expect(await bind(s.ticket, T1, s.leader, newKey())).toBe("refused");
      expect(await bind(s.ticket, T1, friend, newKey())).toBe("bound_first");
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c1.end();
      await c2.end();
    }
  });
});

// ── 8–9. give_back_seat ─────────────────────────────────────────────────────

describe("give_back_seat", () => {
  it("8. gives back: holder cleared, friend's phone revoked, one event; leader's next bind is first; shareable again", async () => {
    const s = await seat();
    // The leader bound before sharing, so a bound_first after the give-back is decision 3.
    expect(await bind(s.ticket, T1, s.leader, newKey())).toBe("bound_first");
    const h = hash();
    expect((await create(s.ticket, T1, s.leader, h)).result).toBe("created");
    const friend = await newBuyer();
    expect((await claim(h, T1, friend)).result).toBe("claimed");
    expect(await bind(s.ticket, T1, friend, newKey())).toBe("bound_first");

    expect(await giveBack(s.ticket, T1, friend)).toEqual({ result: "given_back", leader_id: s.leader });
    expect(await holder(s.ticket)).toBeNull();
    expect(await activeDevices(s.ticket)).toHaveLength(0);
    const friendRow = (await devices(s.ticket)).find((d) => d.buyer_id === friend)!;
    expect(friendRow.revoked_by).toBe("holder_changed");
    expect((await events(s.ticket)).filter((e) => e.event === "given_back")).toEqual([
      { event: "given_back", actor_buyer_id: friend, actor_staff_id: null, from_buyer_id: friend, to_buyer_id: s.leader },
    ]);

    expect(await bind(s.ticket, T1, s.leader, newKey())).toBe("bound_first");
    expect((await create(s.ticket, T1, s.leader, hash())).result).toBe("created");
  });

  it("9. refuses each bad give-back and changes nothing", async () => {
    const a = await claimedSeat();
    const b = await claimedSeat();
    await setToday(b.classId);
    const c = await claimedSeat();
    await sql(`UPDATE tickets SET first_scan_at = now() WHERE id = $1`, [c.ticket]);
    const d = await claimedSeat();
    await sql(`UPDATE enrollments SET buyer_id = NULL WHERE id = $1`, [d.enrollmentId]);
    const e = await claimedSeat();
    await sql(`UPDATE buyer_profiles SET deleted_at = now() WHERE id = $1`, [e.leader]);

    const cases: [string, string, string, string][] = [
      ["the leader (not the holder)", a.ticket, T1, a.leader],
      ["another buyer", a.ticket, T1, await newBuyer()],
      ["another tenant", a.ticket, T2, a.friend],
      ["past the cutoff", b.ticket, T1, b.friend],
      ["an admitted seat", c.ticket, T1, c.friend],
      ["an order with no buyer", d.ticket, T1, d.friend],
      ["a leader whose deletion has started", e.ticket, T1, e.friend],
    ];
    for (const [label, t, ten, who] of cases) {
      const before = await holder(t);
      const evBefore = (await events(t)).length;
      expect({ label, ...(await giveBack(t, ten, who)) }).toEqual({ label, result: "refused", leader_id: null });
      expect({ label, h: await holder(t), n: (await events(t)).length }).toEqual({ label, h: before, n: evBefore });
    }
  });
});

// ── 10. bind and the holder ─────────────────────────────────────────────────

describe("bind_ticket_device and the holder", () => {
  it("10. after a claim only the friend binds; after a give-back only the leader", async () => {
    const s = await claimedSeat();
    expect(await bind(s.ticket, T1, s.friend, newKey())).toBe("bound_first");
    expect(await bind(s.ticket, T1, s.leader, newKey())).toBe("refused");
    expect(await bind(s.ticket, T1, s.friend, newKey())).toBe("bound_again");

    expect((await giveBack(s.ticket, T1, s.friend)).result).toBe("given_back");
    expect(await bind(s.ticket, T1, s.leader, newKey())).toBe("bound_first");
    expect(await bind(s.ticket, T1, s.friend, newKey())).toBe("refused");
  });
});

// ── 11–12. void_enrollment_tickets ──────────────────────────────────────────

describe("void_enrollment_tickets", () => {
  it("11. voids every valid ticket, cancels open links, logs voided, keeps the holder; idempotent", async () => {
    const s = await seat({ tickets: 2 });
    const [t1, t2] = s.ticketIds;
    expect((await create(t1, T1, s.leader, hash())).result).toBe("created");
    const h2 = hash();
    expect((await create(t2, T1, s.leader, h2)).result).toBe("created");
    const friend = await newBuyer();
    expect((await claim(h2, T1, friend)).result).toBe("claimed");

    expect(await voidOrder(s.enrollmentId)).toBe(2);
    const rows = await sql<{ id: string; status: string; holder_buyer_id: string | null }>(
      `SELECT id, status, holder_buyer_id FROM tickets WHERE enrollment_id = $1`,
      [s.enrollmentId],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.holder_buyer_id]]))).toEqual({
      [t1]: ["void", null],
      [t2]: ["void", friend],
    });
    expect(await openLinks(t1)).toHaveLength(0);
    expect((await links(t1))[0].cancelled_at).not.toBeNull();
    for (const t of [t1, t2]) {
      expect((await events(t)).filter((e) => e.event === "voided")).toEqual([
        { event: "voided", actor_buyer_id: null, actor_staff_id: null, from_buyer_id: null, to_buyer_id: null },
      ]);
    }

    const n1 = (await events(t1)).length;
    const n2 = (await events(t2)).length;
    expect(await voidOrder(s.enrollmentId)).toBe(0);
    expect((await events(t1)).length).toBe(n1);
    expect((await events(t2)).length).toBe(n2);
  });

  it("12. a claim racing a void: void first refuses the claim; claim first leaves a claimed, void seat", async () => {
    for (const voidFirst of [true, false]) {
      const s = await sharedSeat();
      const friend = await newBuyer();
      const c1 = new Client({ connectionString: process.env.DATABASE_URL });
      const c2 = new Client({ connectionString: process.env.DATABASE_URL });
      await c1.connect();
      await c2.connect();
      try {
        await c1.query("BEGIN");
        if (voidFirst) {
          await c1.query(`SELECT public.void_enrollment_tickets($1)`, [s.enrollmentId]);
        } else {
          const r = await c1.query(`SELECT * FROM public.claim_share_link($1,$2,$3)`, [s.hash, T1, friend]);
          expect(r.rows[0].result).toBe("claimed");
        }
        const pid = (await c2.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
        const pending = voidFirst
          ? c2.query(`SELECT * FROM public.claim_share_link($1,$2,$3) AS r`, [s.hash, T1, friend])
          : c2.query(`SELECT public.void_enrollment_tickets($1) AS n`, [s.enrollmentId]);
        pending.catch(() => {});
        expect(await waitForLock(pid)).toBe(true);
        await c1.query("COMMIT");
        const res = await pending;

        const [t] = await sql<{ status: string; holder_buyer_id: string | null }>(
          `SELECT status, holder_buyer_id FROM tickets WHERE id = $1`,
          [s.ticket],
        );
        expect(t.status).toBe("void");
        expect(await openLinks(s.ticket)).toHaveLength(0);
        if (voidFirst) {
          expect(res.rows[0].result).toBe("refused");
          expect(t.holder_buyer_id).toBeNull();
          expect((await links(s.ticket))[0].cancelled_at).not.toBeNull();
        } else {
          expect(res.rows[0].n).toBe(1);
          expect(t.holder_buyer_id).toBe(friend);
        }
      } finally {
        await c1.query("ROLLBACK").catch(() => {});
        await c1.end();
        await c2.end();
      }
    }
  });
});

// ── 13. move_order_buyer ────────────────────────────────────────────────────

describe("move_order_buyer and shared seats", () => {
  it("13. moves only the leader's seats, cancels their links, logs order_moved with the staff actor", async () => {
    const s = await seat({ tickets: 2 });
    const [seat1, seat2] = s.ticketIds;
    expect(await bind(seat1, T1, s.leader, newKey())).toBe("bound_first");
    expect((await create(seat1, T1, s.leader, hash())).result).toBe("created");
    const h2 = hash();
    expect((await create(seat2, T1, s.leader, h2)).result).toBe("created");
    const friend = await newBuyer();
    expect((await claim(h2, T1, friend)).result).toBe("claimed");
    const friendKey = newKey();
    expect(await bind(seat2, T1, friend, friendKey)).toBe("bound_first");

    const B3 = await newBuyer();
    expect(await move(s.enrollmentId, T1, S1, B3, "lost mailbox")).toEqual({ result: "moved", from_buyer_id: s.leader });

    expect(await activeDevices(seat1)).toHaveLength(0);
    expect((await devices(seat1))[0].revoked_by).toBe("order_moved");
    expect(await openLinks(seat1)).toHaveLength(0);
    expect((await events(seat1)).filter((e) => e.event === "order_moved")).toEqual([
      { event: "order_moved", actor_buyer_id: null, actor_staff_id: S1, from_buyer_id: s.leader, to_buyer_id: B3 },
    ]);

    expect(await holder(seat2)).toBe(friend);
    const active2 = await activeDevices(seat2);
    expect(active2).toHaveLength(1);
    expect(active2[0].public_key).toBe(friendKey);
    expect((await events(seat2)).filter((e) => e.event === "order_moved")).toHaveLength(0);

    expect(await bind(seat1, T1, B3, newKey())).toBe("bound_first");
  });
});

// ── 14. revoke_buyer_ticket_devices ─────────────────────────────────────────

describe("revoke_buyer_ticket_devices and sharing", () => {
  it("14. a friend: revoked, holder_deleted once; a leader: open links cancelled; deleteUser returns the seat", async () => {
    const s = await seat({ tickets: 2 });
    const [seat1, seat2] = s.ticketIds;
    const h1 = hash();
    expect((await create(seat1, T1, s.leader, h1)).result).toBe("created");
    const friend = await newBuyer();
    expect((await claim(h1, T1, friend)).result).toBe("claimed");
    expect(await bind(seat1, T1, friend, newKey())).toBe("bound_first");
    expect((await create(seat2, T1, s.leader, hash())).result).toBe("created");

    expect(await revoke(friend)).toBe(1);
    expect(await activeDevices(seat1)).toHaveLength(0);
    expect((await devices(seat1)).at(-1)!.revoked_by).toBe("account_deleted");
    const deleted = (await events(seat1)).filter((e) => e.event === "holder_deleted");
    expect(deleted).toEqual([
      { event: "holder_deleted", actor_buyer_id: friend, actor_staff_id: null, from_buyer_id: friend, to_buyer_id: null },
    ]);
    expect(await revoke(friend)).toBe(0);
    expect((await events(seat1)).filter((e) => e.event === "holder_deleted")).toHaveLength(1);

    expect(await revoke(s.leader)).toBe(0);
    expect(await openLinks(seat2)).toHaveLength(0);
    expect((await events(seat2)).filter((e) => e.event === "link_cancelled")).toEqual([
      { event: "link_cancelled", actor_buyer_id: s.leader, actor_staff_id: null, from_buyer_id: s.leader, to_buyer_id: null },
    ]);

    await sql(`DELETE FROM auth.users WHERE id = $1`, [friend]);
    expect(await holder(seat1)).toBeNull();
    expect(await bind(seat1, T1, s.leader, newKey())).toBe("bound_first");
  });

  it("14b. no deadlock with a claim of the leader's link", async () => {
    const s = await sharedSeat();
    const friend = await newBuyer();
    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query("BEGIN");
      const r = await c1.query(`SELECT * FROM public.claim_share_link($1,$2,$3)`, [s.hash, T1, friend]);
      expect(r.rows[0].result).toBe("claimed");

      const pid = (await c2.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const pending = c2.query(`SELECT public.revoke_buyer_ticket_devices($1) AS n`, [s.leader]);
      pending.catch(() => {});
      expect(await waitForLock(pid)).toBe(true);
      await c1.query("COMMIT");

      await expect(pending).resolves.toBeTruthy();
      expect(await holder(s.ticket)).toBe(friend);
      expect((await events(s.ticket)).filter((e) => e.event === "link_cancelled")).toHaveLength(0);
      const [l] = await links(s.ticket);
      expect(l.claimed_by).toBe(friend);
      expect(l.cancelled_at).toBeNull();
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c1.end();
      await c2.end();
    }
  });

  it("14c. a bind racing a give-back keeps the new-phone email (decision 3)", async () => {
    const s = await seat();
    expect(await bind(s.ticket, T1, s.leader, newKey())).toBe("bound_first");
    const h = hash();
    expect((await create(s.ticket, T1, s.leader, h)).result).toBe("created");
    const friend = await newBuyer();
    expect((await claim(h, T1, friend)).result).toBe("claimed");
    expect(await bind(s.ticket, T1, friend, newKey())).toBe("bound_first");

    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      // The bind's transaction starts before the give-back, so its now() is
      // earlier than the given_back event: only clock_timestamp() orders them.
      await c2.query("BEGIN");
      await c2.query("SELECT now()");
      await c1.query("BEGIN");
      const r = await c1.query(`SELECT * FROM public.give_back_seat($1,$2,$3)`, [s.ticket, T1, friend]);
      expect(r.rows[0].result).toBe("given_back");

      const pid = (await c2.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const pending = c2.query(`SELECT public.bind_ticket_device($1,$2,$3,$4) AS r`, [s.ticket, T1, s.leader, newKey()]);
      pending.catch(() => {});
      expect(await waitForLock(pid)).toBe(true);
      await c1.query("COMMIT");

      expect((await pending).rows[0].r).toBe("bound_first");
      await c2.query("COMMIT");
      expect(await bind(s.ticket, T1, s.leader, newKey())).toBe("bound_again");
    } finally {
      await c1.query("ROLLBACK").catch(() => {});
      await c2.query("ROLLBACK").catch(() => {});
      await c1.end();
      await c2.end();
    }
  });
});

// ── 15. The cutoff ──────────────────────────────────────────────────────────

describe("share_cutoff and seat_open_for_sharing", () => {
  it("15. the cutoff is the start of the event day in Yangon minus 24 hours; NULL for no date", async () => {
    expect(DEFAULT_TICKET_TZ).toBe("Asia/Yangon");
    const [{ c, n }] = await sql<{ c: Date; n: Date | null }>(
      `SELECT public.share_cutoff('2026-12-05') AS c, public.share_cutoff(NULL) AS n`,
    );
    expect(c.toISOString()).toBe("2026-12-03T17:30:00.000Z");
    expect(n).toBeNull();

    // The zone in share_cutoff equals the app's default.
    const [{ src }] = await sql<{ src: string }>(
      `SELECT replace(prosrc, chr(13), '') AS src FROM pg_proc WHERE oid = 'public.share_cutoff(date)'::regprocedure`,
    );
    expect([...src.matchAll(/AT TIME ZONE '([^']+)'/g)].map((m) => m[1])).toEqual([DEFAULT_TICKET_TZ]);
  });

  it("15. one second either side of the cutoff", async () => {
    // event_date is a date, so the cutoff can't be put one second from now();
    // test the comparison seat_open_for_sharing makes against computed times.
    const [row] = await sql<{ before: boolean; at: boolean; after: boolean }>(
      `SELECT (c - interval '1 second') < c AS before, c < c AS at, (c + interval '1 second') < c AS after
         FROM (SELECT public.share_cutoff('2026-12-05') AS c) x`,
    );
    expect(row).toEqual({ before: true, at: false, after: false });
    const [{ src }] = await sql<{ src: string }>(
      `SELECT replace(prosrc, chr(13), '') AS src FROM pg_proc
        WHERE oid = 'public.seat_open_for_sharing(uuid,uuid)'::regprocedure`,
    );
    expect(src).toContain("now() < public.share_cutoff(c.event_date)");

    // And on real seats: the day boundary. days = 2 is open, days = 1 is closed.
    const open = await seat({ days: 2 });
    const closed = await seat({ days: 1 });
    const [r] = await sql<{ o: boolean; c: boolean }>(
      `SELECT public.seat_open_for_sharing($1, $3) AS o, public.seat_open_for_sharing($2, $3) AS c`,
      [open.ticket, closed.ticket, T1],
    );
    expect(r).toEqual({ o: true, c: false });
  });
});

// ── 16. Authenticated sessions get nothing ──────────────────────────────────

const FUNCTIONS = [
  "public.share_cutoff(date)",
  "public.seat_open_for_sharing(uuid,uuid)",
  "public.create_share_link(uuid,uuid,uuid,text)",
  "public.cancel_share_link(uuid,uuid,uuid)",
  "public.preview_share_link(text,uuid,uuid)",
  "public.claim_share_link(text,uuid,uuid)",
  "public.give_back_seat(uuid,uuid,uuid)",
  "public.void_enrollment_tickets(uuid)",
  "public.bind_ticket_device(uuid,uuid,uuid,text)",
  "public.move_order_buyer(uuid,uuid,uuid,uuid,text)",
  "public.revoke_buyer_ticket_devices(uuid)",
];

describe("authenticated sessions get nothing", () => {
  async function runAs(text: string, params: unknown[] = []) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE authenticated");
      const res = await client.query(text, params);
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  }

  it.each(FUNCTIONS)("16. authenticated can't execute %s; service_role can", async (fn) => {
    const [row] = await sql<{ a: boolean; n: boolean; s: boolean }>(
      `SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS a,
              has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS n,
              has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS s`,
      [fn],
    );
    expect(row).toEqual({ a: false, n: false, s: true });
  });

  it("16. an authenticated session calling create_share_link gets 42501", async () => {
    await expect(
      runAs(`SELECT * FROM public.create_share_link($1,$2,$3,$4)`, [randomUUID(), T1, randomUUID(), hash()]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // Locally setup.ts re-grants table DML to authenticated and service_role, so
  // RLS (no policies) is what refuses here, and the "nothing else" half of
  // service_role's grants can only be proven on a hosted database. What setup
  // doesn't touch is TRUNCATE, REFERENCES and TRIGGER.
  it.each(["ticket_share_links", "ticket_holder_events"])("16. authenticated sees zero rows of %s", async (table) => {
    const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
    expect(n).toBeGreaterThan(0);
    expect((await runAs(`SELECT * FROM public.${table}`)).rowCount).toBe(0);
  });

  it.each([
    ["ticket_share_links", ["SELECT", "INSERT", "UPDATE"]],
    ["ticket_holder_events", ["SELECT", "INSERT"]],
  ])("16. service_role's privileges on %s", async (table, granted) => {
    for (const p of granted) {
      const [{ ok }] = await sql<{ ok: boolean }>(`SELECT has_table_privilege('service_role', $1, $2) AS ok`, [
        `public.${table}`,
        p,
      ]);
      expect({ p, ok }).toEqual({ p, ok: true });
    }
    for (const p of ["TRUNCATE", "REFERENCES", "TRIGGER"]) {
      const [{ ok }] = await sql<{ ok: boolean }>(`SELECT has_table_privilege('service_role', $1, $2) AS ok`, [
        `public.${table}`,
        p,
      ]);
      expect({ p, ok }).toEqual({ p, ok: false });
    }
  });
});

// ── 17. preview_share_link ──────────────────────────────────────────────────

describe("preview_share_link", () => {
  it("17. one row for an open link and the right claimer; none for every refused claim", async () => {
    const s = await sharedSeat();
    const friend = await newBuyer();
    const rows = await preview(s.hash, T1, friend);
    const [{ d }] = await sql<{ d: Date }>(`SELECT event_date AS d FROM classes WHERE id = $1`, [s.classId]);
    expect(rows).toEqual([{ event_name: "Seat sharing intake", tier: "General", seat_no: 1, event_date: d }]);
    // A preview changes nothing.
    expect(await holder(s.ticket)).toBeNull();
    expect(await openLinks(s.ticket)).toHaveLength(1);

    for (const c of await claimRefusals()) {
      expect({ label: c.label, rows: await preview(c.hash, c.tenant, c.claimer) }).toEqual({ label: c.label, rows: [] });
    }
  });
});
