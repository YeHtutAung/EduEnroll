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

  // Idempotency guard: bail if any tickets already exist for this enrollment.
  const { count } = (await supabase
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .eq("enrollment_id", enrollmentId)) as unknown as { count: number | null };
  if ((count ?? 0) > 0) return;

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, tenant_id, class_id, quantity")
    .eq("id", enrollmentId)
    .single()) as unknown as {
    data: {
      id: string;
      tenant_id: string;
      class_id: string | null;
      quantity: number | null;
    } | null;
  };
  if (!enrollment) return;

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
    for (let i = 0; i < line.quantity; i++) {
      rows.push({
        tenant_id: enrollment.tenant_id,
        intake_id: c.intake_id,
        enrollment_id: enrollmentId,
        class_id: line.class_id,
        tier: c.level,
        admits: 1,
        exp: expIso,
        kid,
        status: "valid",
      });
    }
  }
  if (rows.length) await supabase.from("tickets").insert(rows as never);
}

/** Marks every ticket belonging to an enrollment as void (e.g. on refund/cancellation). */
export async function voidTicketsForEnrollment(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("tickets")
    .update({ status: "void" } as never)
    .eq("enrollment_id", enrollmentId);
}
