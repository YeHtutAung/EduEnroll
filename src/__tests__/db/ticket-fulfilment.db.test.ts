import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { Pool } from "pg";

// ─── Ticket fulfilment: the helper's real behaviour against a real database ──
//
// Issuance runs only AFTER each webhook's replay guard, which returns early
// when the payment is already verified — so the replay branch never issues, and
// the browser confirm paths never issue at all. Measured on dev, event tenants:
// 9 of 67 confirmed enrollments have tickets.
//
// These cover the helper. Route behaviour lives in the route suites, because a
// mocked helper can only prove it was CALLED, not that rows exist.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

type Tracked = { tenants: string[]; intakes: string[]; classes: string[]; enrollments: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], enrollments: [] });

let seq = 0;
const uniq = () => `tf${Date.now().toString(36)}${seq++}`;

async function createTenant(orgType = "event"): Promise<string> {
  const slug = uniq();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1,$2,$3) RETURNING id`,
    [`Fulfil ${slug}`, slug, orgType],
  );
  made.tenants.push(row.id);
  return row.id;
}

async function createIntake(tenantId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id, name, year) VALUES ($1,'Fulfil intake',2026) RETURNING id`,
    [tenantId],
  );
  made.intakes.push(row.id);
  return row.id;
}

async function createClassRow(tenantId: string, intakeId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id,intake_id,level,fee_amount,seat_total,seat_remaining,status,
                          max_tickets_per_person,event_date)
     VALUES ($1,$2,$3,100,100,90,'open',10, now() + interval '30 days') RETURNING id`,
    [tenantId, intakeId, `L${uniq()}`],
  );
  made.classes.push(row.id);
  return row.id;
}

/** Confirmed by default: the helper only issues for confirmed enrollments (#187). */
async function createEnrollment(opts: {
  tenantId: string;
  classId: string | null;
  quantity?: number;
  status?: string;
}): Promise<string> {
  const { tenantId, classId, quantity = 1, status = "confirmed" } = opts;
  const [row] = await sql<{ id: string }>(
    `INSERT INTO enrollments (enrollment_ref,tenant_id,student_name_en,phone,class_id,quantity,status)
     VALUES ('',$1,'Fulfil Test','09000000000',$2,$3,$4::enrollment_status) RETURNING id`,
    [tenantId, classId, quantity, status],
  );
  made.enrollments.push(row.id);
  return row.id;
}

const addItem = (enrollmentId: string, classId: string, tenantId: string, quantity: number) =>
  sql(
    `INSERT INTO enrollment_items (enrollment_id,class_id,tenant_id,fee_amount,quantity)
     VALUES ($1,$2,$3,100,$4)`,
    [enrollmentId, classId, tenantId, quantity],
  );

const ticketCount = async (enrollmentId: string) =>
  Number(
    (
      await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM tickets WHERE enrollment_id = $1`,
        [enrollmentId],
      )
    )[0].n,
  );

const seatNumbers = async (enrollmentId: string) =>
  (
    await sql<{ seat_no: number }>(
      `SELECT seat_no FROM tickets WHERE enrollment_id = $1 ORDER BY seat_no`,
      [enrollmentId],
    )
  ).map((r) => Number(r.seat_no));

const issueTickets = async (enrollmentId: string) => {
  const { issueTicketsForEnrollment } = await import("@/server/tickets/issueTickets");
  return issueTicketsForEnrollment(enrollmentId);
};

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1");
});

afterEach(async () => {
  const { tenants, intakes, classes, enrollments } = made;
  if (enrollments.length) {
    await sql(`DELETE FROM tickets WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM enrollment_items WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
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

describe("issueTicketsForEnrollment — real database", () => {
  it("H1 issues tickets for a confirmed event enrollment", async () => {
    const t = await createTenant("event");
    const i = await createIntake(t);
    const c = await createClassRow(t, i);
    const e = await createEnrollment({ tenantId: t, classId: c, quantity: 2 });

    await issueTickets(e);

    expect(await ticketCount(e)).toBe(2);
  });

  it("H2 issues nothing for a confirmed language-school enrollment", async () => {
    // Language-school enrollments are ticketless today only because the
    // settlement race prevented issuance — no rule enforces it. Once fulfilment
    // is reliable they would start receiving admission tickets.
    const t = await createTenant("language_school");
    const i = await createIntake(t);
    const c = await createClassRow(t, i);
    const e = await createEnrollment({ tenantId: t, classId: c, quantity: 2 });

    await issueTickets(e);

    expect(await ticketCount(e)).toBe(0);
  });

  it("H3 repairs a partial set rather than treating it as complete", async () => {
    const t = await createTenant();
    const i = await createIntake(t);
    const c = await createClassRow(t, i);
    const e = await createEnrollment({ tenantId: t, classId: c, quantity: 3 });

    await issueTickets(e);
    // Simulate a prior run that issued only one of three.
    await sql(`DELETE FROM tickets WHERE enrollment_id = $1 AND seat_no > 1`, [e]);
    expect(await ticketCount(e)).toBe(1);

    await issueTickets(e);

    expect(await ticketCount(e)).toBe(3);
  });

  it("H4 throws for a cart enrollment with zero items", async () => {
    const t = await createTenant();
    await createIntake(t);
    const e = await createEnrollment({ tenantId: t, classId: null });

    await expect(issueTickets(e)).rejects.toThrow();
  });

  it("H5 leaves an existing void ticket untouched", async () => {
    const t = await createTenant();
    const i = await createIntake(t);
    const c = await createClassRow(t, i);
    const e = await createEnrollment({ tenantId: t, classId: c, quantity: 2 });

    await issueTickets(e);
    await sql(`UPDATE tickets SET status = 'void' WHERE enrollment_id = $1 AND seat_no = 1`, [e]);

    await issueTickets(e);

    // The unique key excludes status, so a void row is skipped, not resurrected.
    const [row] = await sql<{ status: string }>(
      `SELECT status FROM tickets WHERE enrollment_id = $1 AND seat_no = 1`,
      [e],
    );
    expect(row.status).toBe("void");
    expect(await ticketCount(e)).toBe(2);
  });

  it("H6 issues nothing for a rejected enrollment", async () => {
    const t = await createTenant();
    const i = await createIntake(t);
    const c = await createClassRow(t, i);
    const e = await createEnrollment({ tenantId: t, classId: c, status: "rejected" });

    await issueTickets(e);

    expect(await ticketCount(e)).toBe(0);
  });

  it("H7 numbers seats across duplicate cart lines for the same class", async () => {
    // Nothing enforces uniqueness on (enrollment_id, class_id) — the only unique
    // index on enrollment_items is its primary key. Seat numbering that restarts
    // per line produces A:1, A:1, A:2; the tickets unique key collapses the
    // duplicate and two tickets persist for a paid quantity of three.
    const t = await createTenant();
    const i = await createIntake(t);
    const c = await createClassRow(t, i);
    const e = await createEnrollment({ tenantId: t, classId: null });
    await addItem(e, c, t, 1);
    await addItem(e, c, t, 2);

    await issueTickets(e);

    expect(await ticketCount(e)).toBe(3);
    expect(await seatNumbers(e)).toEqual([1, 2, 3]);
  });
});
