import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { NextRequest } from "next/server";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

let tenantId = "";
let intakeId = "";
let directClassId = "";
let cartClassId = "";
let seq = 0;
const made = { enrollments: [] as string[] };
const uniq = () => `ita${Date.now().toString(36)}${seq++}`;

vi.mock("@/lib/api", () => ({
  requireAuth: async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    return { supabase: createAdminClient(), tenantId };
  },
}));

async function makeEnrollment(input: {
  status: "pending_payment" | "confirmed" | "rejected";
  quantity?: number;
  cart?: boolean;
  verifiedPayment?: boolean;
}) {
  const quantity = input.quantity ?? 1;
  const [e] = await sql<{ id: string }>(
    `insert into enrollments
       (tenant_id,class_id,student_name_en,phone,status,enrollment_ref,quantity)
     values ($1,$2,$3,'1',$4,$5,$6) returning id`,
    [tenantId, input.cart ? null : directClassId, uniq(), input.status, uniq(), quantity],
  );
  made.enrollments.push(e.id);
  if (input.cart) {
    await sql(
      `insert into enrollment_items
         (enrollment_id,class_id,tenant_id,quantity,fee_amount)
       values ($1,$2,$3,$4,10)`,
      [e.id, cartClassId, tenantId, quantity],
    );
  }
  if (input.verifiedPayment) {
    await sql(
      `insert into payments (enrollment_id,tenant_id,amount,payment_method,status)
       values ($1,$2,10,'manual_upload','verified')`,
      [e.id, tenantId],
    );
  }
  return e.id;
}

async function archive(id: string) {
  const [row] = await sql<{ result: Record<string, unknown> }>(
    `select public.archive_internal_test_enrollment($1,$2) result`,
    [id, "production launch smoke"],
  );
  return row.result;
}

beforeAll(async () => {
  const slug = uniq();
  const [tenant] = await sql<{ id: string }>(
    `insert into tenants (name,subdomain,org_type) values ($1,$2,'event') returning id`,
    [`Archive ${slug}`, slug],
  );
  tenantId = tenant.id;
  const [intake] = await sql<{ id: string }>(
    `insert into intakes (tenant_id,name,year,status)
     values ($1,$2,2026,'open') returning id`,
    [tenantId, `Archive ${slug}`],
  );
  intakeId = intake.id;
  const classes = await sql<{ id: string }>(
    `insert into classes
       (tenant_id,intake_id,level,fee_amount,seat_total,seat_remaining,status,max_tickets_per_person)
     values ($1,$2,'DIRECT',10,50,30,'open',10),
            ($1,$2,'CART',10,50,30,'open',10)
     returning id`,
    [tenantId, intakeId],
  );
  [directClassId, cartClassId] = classes.map((c) => c.id);
});

afterAll(async () => {
  if (made.enrollments.length) {
    await sql(`delete from tickets where enrollment_id = any($1::uuid[])`, [made.enrollments]);
    await sql(`delete from payment_settlement_conflicts where enrollment_id = any($1::uuid[])`, [made.enrollments]);
    await sql(`delete from payments where enrollment_id = any($1::uuid[])`, [made.enrollments]);
    await sql(`delete from enrollment_items where enrollment_id = any($1::uuid[])`, [made.enrollments]);
    await sql(`delete from enrollments where id = any($1::uuid[])`, [made.enrollments]);
  }
  await sql(`delete from classes where id = any($1::uuid[])`, [[directClassId, cartClassId]]);
  await sql(`delete from intakes where id = $1`, [intakeId]);
  await sql(`delete from tenants where id = $1`, [tenantId]);
  await pool.end();
});

describe("archive_internal_test_enrollment", () => {
  it("A1 preserves payment history, voids tickets, and restores direct capacity", async () => {
    const id = await makeEnrollment({ status: "confirmed", quantity: 2, verifiedPayment: true });
    await sql(
      `insert into tickets
         (tenant_id,intake_id,enrollment_id,class_id,tier,admits,seat_no,exp,kid,status)
       values ($1,$2,$3,$4,'DIRECT',1,1,now() + interval '1 day','test','valid'),
              ($1,$2,$3,$4,'DIRECT',1,2,now() + interval '1 day','test','valid')`,
      [tenantId, intakeId, id, directClassId],
    );
    const [{ seat_remaining: before }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );

    expect(await archive(id)).toMatchObject({ archived: true, already_archived: false });

    const [e] = await sql<{ internal_test_at: string; internal_test_reason: string }>(
      `select internal_test_at,internal_test_reason from enrollments where id=$1`, [id],
    );
    const [{ seat_remaining: after }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );
    const [{ payments, valid_tickets, void_tickets }] = await sql<{
      payments: number; valid_tickets: number; void_tickets: number;
    }>(
      `select
         (select count(*)::int from payments where enrollment_id=$1) payments,
         (select count(*)::int from tickets where enrollment_id=$1 and status='valid') valid_tickets,
         (select count(*)::int from tickets where enrollment_id=$1 and status='void') void_tickets`,
      [id],
    );
    expect(e.internal_test_at).toBeTruthy();
    expect(e.internal_test_reason).toBe("production launch smoke");
    expect(after).toBe(before + 2);
    expect({ payments, valid_tickets, void_tickets }).toEqual({ payments: 1, valid_tickets: 0, void_tickets: 2 });
  });

  it("A2 is idempotent and never restores capacity twice", async () => {
    const id = await makeEnrollment({ status: "confirmed", verifiedPayment: true });
    await archive(id);
    const [{ seat_remaining: once }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );
    expect(await archive(id)).toMatchObject({ archived: true, already_archived: true });
    const [{ seat_remaining: twice }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );
    expect(twice).toBe(once);
  });

  it("A3 deleting an archived confirmed row does not restore again", async () => {
    const id = await makeEnrollment({ status: "confirmed", verifiedPayment: true });
    await archive(id);
    const [{ seat_remaining: before }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );
    await sql(`delete from payments where enrollment_id=$1`, [id]);
    await sql(`delete from enrollments where id=$1`, [id]);
    const [{ seat_remaining: after }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );
    expect(after).toBe(before);
  });

  it("A4 rejected rows archive without changing already-restored capacity", async () => {
    const id = await makeEnrollment({ status: "rejected", verifiedPayment: true });
    const [{ seat_remaining: before }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );
    await archive(id);
    const [{ seat_remaining: after }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );
    expect(after).toBe(before);
  });

  it("A5 restores cart quantities exactly once", async () => {
    const id = await makeEnrollment({ status: "confirmed", quantity: 3, cart: true, verifiedPayment: true });
    const [{ seat_remaining: before }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [cartClassId],
    );
    await archive(id);
    const [{ seat_remaining: after }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [cartClassId],
    );
    expect(after).toBe(before + 3);
  });

  it("A6 refuses a pending enrollment and leaves it visible", async () => {
    const id = await makeEnrollment({ status: "pending_payment" });
    await expect(archive(id)).rejects.toThrow(/only confirmed or rejected/);
    const [e] = await sql<{ internal_test_at: string | null }>(
      `select internal_test_at from enrollments where id=$1`, [id],
    );
    expect(e.internal_test_at).toBeNull();
  });

  it("A7 refuses an unresolved settlement conflict", async () => {
    const id = await makeEnrollment({ status: "rejected", verifiedPayment: true });
    await sql(
      `insert into payment_settlement_conflicts
         (provider,provider_object_id,first_source_type,first_source_id,last_source_type,last_source_id,
          enrollment_id,conflict_type,status,cleanup_status)
       values ('stripe',$2,'webhook_event',$3,'webhook_event',$3,$1,'rejected_enrollment','open','none')`,
      [id, `pi_${uniq()}`, `evt_${uniq()}`],
    );
    await expect(archive(id)).rejects.toThrow(/unresolved settlement conflict/);
  });

  it("A8 exposes archive only to service_role", async () => {
    const [r] = await sql<{ anon: boolean; authenticated: boolean; service: boolean }>(`
      select
        has_function_privilege('anon','public.archive_internal_test_enrollment(uuid,text)','EXECUTE') anon,
        has_function_privilege('authenticated','public.archive_internal_test_enrollment(uuid,text)','EXECUTE') authenticated,
        has_function_privilege('service_role','public.archive_internal_test_enrollment(uuid,text)','EXECUTE') service
    `);
    expect(r).toEqual({ anon: false, authenticated: false, service: true });
  });

  it("A8b rejects direct writes that bypass atomic capacity and ticket cleanup", async () => {
    const id = await makeEnrollment({ status: "confirmed", verifiedPayment: true });
    await expect(
      sql(`update enrollments set internal_test_at=now(),internal_test_reason='bypass' where id=$1`, [id]),
    ).rejects.toThrow(/function-owned/);
  });

  it("A9 ticket fulfilment never resurrects an archived admission", async () => {
    const id = await makeEnrollment({ status: "confirmed", verifiedPayment: true });
    await archive(id);
    const { issueTicketsForEnrollment } = await import("@/server/tickets/issueTickets");
    await issueTicketsForEnrollment(id);
    const [{ count }] = await sql<{ count: number }>(
      `select count(*)::int count from tickets where enrollment_id=$1`, [id],
    );
    expect(count).toBe(0);
  });

  it("A10 later rejection of an archived row cannot restore capacity twice", async () => {
    const id = await makeEnrollment({ status: "confirmed", verifiedPayment: true });
    await archive(id);
    const [{ seat_remaining: before }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );
    await sql(`update enrollments set status='rejected' where id=$1`, [id]);
    const [{ seat_remaining: after }] = await sql<{ seat_remaining: number }>(
      `select seat_remaining from classes where id=$1`, [directClassId],
    );
    expect(after).toBe(before);
  });

  it("A11 restoring archived capacity reopens a full class", async () => {
    await sql(`update classes set seat_remaining=49,status='full' where id=$1`, [directClassId]);
    const id = await makeEnrollment({ status: "confirmed", verifiedPayment: true });
    await archive(id);
    const [c] = await sql<{ seat_remaining: number; status: string }>(
      `select seat_remaining,status from classes where id=$1`, [directClassId],
    );
    expect(c).toEqual({ seat_remaining: 50, status: "open" });
    await sql(`update classes set seat_remaining=30,status='open' where id=$1`, [directClassId]);
  });
});

describe("reporting", () => {
  it("R1 dashboard and revenue exclude archived smoke payments", async () => {
    const { GET } = await import("@/app/api/admin/stats/route");
    const beforeRes = await GET();
    const before = await beforeRes.json();
    expect(beforeRes.status).toBe(200);

    const visible = await makeEnrollment({ status: "confirmed", verifiedPayment: true });
    const archived = await makeEnrollment({ status: "confirmed", verifiedPayment: true });
    await archive(archived);

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total_enrollments).toBe(before.total_enrollments + 1);
    expect(body.confirmed_count).toBe(before.confirmed_count + 1);
    expect(body.total_revenue).toBe(before.total_revenue + 10);

    // Keep the visible row referenced so this assertion cannot pass if fixture
    // creation silently failed and the route simply returned all zeroes.
    expect(visible).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("R2 attendee list hides archived rows", async () => {
    const archived = await makeEnrollment({ status: "confirmed", verifiedPayment: true });
    const [{ enrollment_ref: ref }] = await sql<{ enrollment_ref: string }>(
      `select enrollment_ref from enrollments where id=$1`, [archived],
    );
    await archive(archived);
    const { GET } = await import("@/app/api/admin/students/route");
    const res = await GET(new NextRequest("http://localhost/api/admin/students?search=" + ref));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it("R3 verified payment on a rejected enrollment is not revenue", async () => {
    await makeEnrollment({ status: "rejected", verifiedPayment: true });
    const [r] = await sql<{ revenue: number }>(
      `select public.get_tenant_revenue($1)::int revenue`, [tenantId],
    );
    const [{ expected }] = await sql<{ expected: number }>(
      `select coalesce(sum(p.amount),0)::int expected
       from payments p join enrollments e on e.id=p.enrollment_id
       where p.tenant_id=$1 and p.status='verified'
         and e.status='confirmed' and e.internal_test_at is null`,
      [tenantId],
    );
    expect(r.revenue).toBe(expected);
  });
});
