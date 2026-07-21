import { createAdminClient } from "@/lib/supabase/admin";
import { ticketExpiry } from "@/lib/tickets/exp";
import { loadSigningKey } from "@/lib/tickets/keys";

const TZ = process.env.TICKET_TZ ?? "Asia/Yangon";

/**
 * Materializes one `tickets` row per admission for an enrollment.
 * Idempotent: if tickets already exist for this enrollment, does nothing.
 * Handles both single-class enrollments (enrollments.class_id set) and
 * cart orders (enrollments.class_id is null, lines come from enrollment_items).
 */
export async function issueTicketsForEnrollment(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();

  // Idempotency fast-path: skip work if tickets already exist for this enrollment.
  // Not the sole guarantee — the DB-level unique index + upsert below is authoritative,
  // so a failure/error on this count query is non-fatal and we just proceed.
  let count: number | null = 0;
  try {
    const res = (await supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("enrollment_id", enrollmentId)) as unknown as { count: number | null };
    count = res.count;
  } catch {
    count = 0;
  }
  if ((count ?? 0) > 0) return;

  // maybeSingle(), not single(): single() reports zero rows as an ERROR, which
  // would make "this enrollment is gone" indistinguishable from "the query
  // failed" — and the error was previously discarded entirely.
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("id, tenant_id, class_id, quantity, status")
    .eq("id", enrollmentId)
    .maybeSingle()) as unknown as {
    data: {
      id: string;
      tenant_id: string;
      class_id: string | null;
      quantity: number | null;
      status: string;
    } | null;
    error: unknown;
  };

  // Throw rather than return: a database failure must not be read as "no
  // tickets needed", which would silently skip fulfillment for a legitimately
  // confirmed enrollment and look identical to success.
  if (enrollmentError) {
    throw new Error(`issueTickets: enrollment load failed: ${JSON.stringify(enrollmentError)}`);
  }
  if (!enrollment) return;

  // ── Admission guard ───────────────────────────────────────────────────────
  // A ticket is an admission. A rejected enrollment has had its seat restored
  // and possibly resold, so issuing one would admit a second customer for that
  // seat — the scanner validates the ticket's own status, not the enrollment's.
  // Declining is correct behaviour, not an error, so return rather than throw.
  if (enrollment.status !== "confirmed") {
    console.warn(
      `[tickets] skipped issuance for non-confirmed enrollment ${enrollmentId} (${enrollment.status})`,
    );
    return;
  }

  // Build (class_id, quantity) lines from either the single class or cart items.
  let lines: { class_id: string; quantity: number }[] = [];
  if (enrollment.class_id) {
    lines = [{ class_id: enrollment.class_id, quantity: enrollment.quantity ?? 1 }];
  } else {
    const { data: items } = (await supabase
      .from("enrollment_items")
      .select("class_id, quantity")
      .eq("enrollment_id", enrollmentId)) as unknown as {
      data: { class_id: string; quantity: number }[] | null;
    };
    lines = items ?? [];
  }
  if (lines.length === 0) return;

  const classIds = lines.map((l) => l.class_id);
  const { data: classes } = (await supabase
    .from("classes")
    .select("id, level, intake_id, event_date")
    .in("id", classIds)) as unknown as {
    data: { id: string; level: string; intake_id: string; event_date: string | null }[] | null;
  };
  const byId = new Map((classes ?? []).map((c) => [c.id, c]));
  const { kid } = loadSigningKey();

  const rows: Record<string, unknown>[] = [];
  for (const line of lines) {
    const c = byId.get(line.class_id);
    if (!c) continue;
    const expIso = new Date(ticketExpiry(c.event_date, TZ) * 1000).toISOString();
    const qty = Math.max(1, line.quantity ?? 1);
    for (let seat = 1; seat <= qty; seat++) {
      rows.push({
        tenant_id: enrollment.tenant_id,
        intake_id: c.intake_id,
        enrollment_id: enrollmentId,
        class_id: line.class_id,
        tier: c.level,
        admits: 1,
        seat_no: seat,
        exp: expIso,
        kid,
        status: "valid",
      });
    }
  }
  if (rows.length) {
    // Idempotent upsert: concurrent issuance (webhook + status polling can both fire)
    // relies on the tickets_enrollment_class_seat_uniq unique index to dedupe safely.
    const { error } = await supabase.from("tickets").upsert(rows as never, {
      onConflict: "enrollment_id,class_id,seat_no",
      ignoreDuplicates: true,
    });
    if (error) throw new Error(`issueTickets upsert failed: ${JSON.stringify(error)}`);
  }
}

/** Marks every ticket belonging to an enrollment as void (e.g. on refund/cancellation). */
export async function voidTicketsForEnrollment(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("tickets")
    .update({ status: "void" } as never)
    .eq("enrollment_id", enrollmentId);
}
