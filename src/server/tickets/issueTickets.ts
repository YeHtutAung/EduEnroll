import { createAdminClient } from "@/lib/supabase/admin";
import { ticketExpiry } from "@/lib/tickets/exp";
import { loadSigningKey } from "@/lib/tickets/keys";

const TZ = process.env.TICKET_TZ ?? "Asia/Yangon";

/**
 * Materializes one `tickets` row per admission for a confirmed event enrollment.
 *
 * Safe to call after any trusted paid signal, including a payment that was
 * already verified: it repairs a missing or partial set rather than assuming
 * "some tickets exist" means "fulfilled". Handles single-class enrollments
 * (enrollments.class_id set) and cart orders (class_id null, lines from
 * enrollment_items).
 *
 * Throws on every query failure. A ticket is an admission, so "the database did
 * not answer" must never be mistaken for "no tickets are needed" — that
 * silently leaves a paying customer without entry.
 */
export async function issueTicketsForEnrollment(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();

  // maybeSingle(), not single(): single() reports zero rows as an ERROR, which
  // would make "this enrollment is gone" indistinguishable from "the query
  // failed".
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("id, tenant_id, class_id, quantity, status, internal_test_at")
    .eq("id", enrollmentId)
    .maybeSingle()) as unknown as {
    data: {
      id: string;
      tenant_id: string;
      class_id: string | null;
      quantity: number | null;
      status: string;
      internal_test_at: string | null;
    } | null;
    error: unknown;
  };

  if (enrollmentError) {
    throw new Error(`issueTickets: enrollment load failed: ${JSON.stringify(enrollmentError)}`);
  }
  if (!enrollment) return;

  // Internal launch/smoke records retain their payment and provider ownership
  // for audit and webhook replay, but are not admissions. Existing rows have
  // been voided atomically by archive_internal_test_enrollment(); returning
  // here also prevents a replay from filling any previously missing tickets.
  if (enrollment.internal_test_at) return;

  // ── Admission guard ───────────────────────────────────────────────────────
  // A rejected enrollment has had its seat restored and possibly resold, so
  // issuing would admit a second customer for that seat — the scanner validates
  // the ticket's own status, not the enrollment's. Declining is correct
  // behaviour, not an error.
  if (enrollment.status !== "confirmed") {
    console.warn(
      `[tickets] skipped issuance for non-confirmed enrollment ${enrollmentId} (${enrollment.status})`,
    );
    return;
  }

  // ── Eligibility ───────────────────────────────────────────────────────────
  // QR admission tickets are an event feature. Language-school enrollments are
  // ticketless today only because a settlement race prevented issuance — no
  // rule enforced it — so reliable fulfilment would start issuing them tickets.
  //
  // A missing tenant is a failure, not a no-op: only a real tenant whose
  // org_type is not "event" is a legitimate skip.
  const { data: tenant, error: tenantError } = (await supabase
    .from("tenants")
    .select("org_type")
    .eq("id", enrollment.tenant_id)
    .maybeSingle()) as unknown as {
    data: { org_type: string | null } | null;
    error: unknown;
  };

  if (tenantError) {
    throw new Error(`issueTickets: tenant load failed: ${JSON.stringify(tenantError)}`);
  }
  if (!tenant) {
    throw new Error(`issueTickets: tenant ${enrollment.tenant_id} not found`);
  }
  if (tenant.org_type !== "event") return;

  // ── Lines ─────────────────────────────────────────────────────────────────
  let rawLines: { class_id: string; quantity: number | null }[];
  if (enrollment.class_id) {
    rawLines = [{ class_id: enrollment.class_id, quantity: enrollment.quantity }];
  } else {
    const { data: items, error: itemsError } = (await supabase
      .from("enrollment_items")
      .select("class_id, quantity")
      .eq("enrollment_id", enrollmentId)) as unknown as {
      data: { class_id: string; quantity: number | null }[] | null;
      error: unknown;
    };
    if (itemsError) {
      throw new Error(`issueTickets: enrollment_items load failed: ${JSON.stringify(itemsError)}`);
    }
    rawLines = items ?? [];
  }

  // A confirmed event enrollment with no lines cannot be fulfilled, and is not
  // a success: previously this returned quietly and the order stayed ticketless.
  if (rawLines.length === 0) {
    throw new Error(`issueTickets: confirmed enrollment ${enrollmentId} has no ticket lines`);
  }

  // Validate BEFORE aggregating: summing first would let an invalid line
  // (quantity 0) hide inside a valid line for the same class.
  for (const line of rawLines) {
    const q = line.quantity ?? 1;
    if (!Number.isInteger(q) || q < 1) {
      throw new Error(
        `issueTickets: enrollment ${enrollmentId} has an invalid quantity for class ${line.class_id}`,
      );
    }
  }

  // Normalise by class. Nothing enforces uniqueness on
  // (enrollment_id, class_id) — the only unique index on enrollment_items is its
  // primary key — and seat numbers restart per line, so two lines for one class
  // (qty 1 + qty 2) would emit seats 1, 1, 2. The tickets unique key collapses
  // the duplicate and only two rows survive for a paid quantity of three.
  // Summing first yields seats 1, 2, 3.
  const byClass = new Map<string, number>();
  for (const line of rawLines) {
    byClass.set(line.class_id, (byClass.get(line.class_id) ?? 0) + (line.quantity ?? 1));
  }
  const expectedTotal = Array.from(byClass.values()).reduce((sum, q) => sum + q, 0);

  const { data: classes, error: classesError } = (await supabase
    .from("classes")
    .select("id, level, intake_id, event_date")
    .in("id", Array.from(byClass.keys()))) as unknown as {
    data: { id: string; level: string; intake_id: string; event_date: string | null }[] | null;
    error: unknown;
  };
  if (classesError) {
    throw new Error(`issueTickets: classes load failed: ${JSON.stringify(classesError)}`);
  }

  const byId = new Map((classes ?? []).map((c) => [c.id, c]));

  // A partial class result previously meant those lines were skipped silently,
  // producing fewer tickets than paid for while reporting success.
  const missing = Array.from(byClass.keys()).filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `issueTickets: enrollment ${enrollmentId} references ${missing.length} class(es) that did not load`,
    );
  }

  const { kid } = loadSigningKey();

  const rows: Record<string, unknown>[] = [];
  for (const [classId, quantity] of Array.from(byClass.entries())) {
    const c = byId.get(classId)!;
    const expIso = new Date(ticketExpiry(c.event_date, TZ) * 1000).toISOString();
    for (let seat = 1; seat <= quantity; seat++) {
      rows.push({
        tenant_id: enrollment.tenant_id,
        intake_id: c.intake_id,
        enrollment_id: enrollmentId,
        class_id: classId,
        tier: c.level,
        admits: 1,
        seat_no: seat,
        exp: expIso,
        kid,
        status: "valid",
      });
    }
  }

  // Two distinct invariants. The row count catches a generation bug; the unique
  // key count catches rows that would collapse on insert and leave the customer
  // short — which the row count alone cannot see.
  if (rows.length !== expectedTotal) {
    throw new Error(
      `issueTickets: generated ${rows.length} rows for expected ${expectedTotal} admissions`,
    );
  }
  const uniqueKeys = new Set(rows.map((r) => `${r.class_id}:${r.seat_no}`));
  if (uniqueKeys.size !== expectedTotal) {
    throw new Error(
      `issueTickets: generated ${uniqueKeys.size} distinct ticket keys for expected ${expectedTotal}`,
    );
  }

  // ignoreDuplicates deliberately: the unique key is
  // (enrollment_id, class_id, seat_no) and excludes status, so an existing void
  // or scanned ticket is left alone rather than resurrected. This repairs
  // MISSING rows only.
  const { error } = await supabase.from("tickets").upsert(rows as never, {
    onConflict: "enrollment_id,class_id,seat_no",
    ignoreDuplicates: true,
  });
  if (error) throw new Error(`issueTickets upsert failed: ${JSON.stringify(error)}`);
}

/** Marks every ticket belonging to an enrollment as void (e.g. on refund/cancellation). */
export async function voidTicketsForEnrollment(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("tickets")
    .update({ status: "void" } as never)
    .eq("enrollment_id", enrollmentId);
}
