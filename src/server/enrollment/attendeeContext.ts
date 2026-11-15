import {
  attendeeSlots,
  validateAttendees,
  type Attendee,
  type AttendeeField,
  type AttendeeResult,
  type AttendeeSlot,
} from "@/lib/enrollment/attendees";

// ─── Runner slots for an order ──────────────────────────────────────────────
//
// Given an order's lines — from the request, or from a stored order — loads
// what @/lib/enrollment/attendees needs: the per-ticket fields of the order's
// event and one slot per admission. Shared by POST /api/public/enroll and
// PATCH /api/public/enrollment/[ref], so both check runners the same way.
//
// The fields come from the classes' OWN event, never from the first item: a
// cart whose classes belong to different events, any of which asks per-ticket
// questions, is refused rather than checked against the wrong form.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export interface AttendeeLine {
  class_id: string;
  quantity: unknown;
}

export type AttendeeContext =
  | { ok: true; fields: AttendeeField[]; slots: AttendeeSlot[] }
  | { ok: false; message: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (t: string) => any };

/** The quantity the RPCs book: same rule as createEnrollment / createCartEnrollment. */
export function normaliseQuantity(quantity: unknown): number {
  return typeof quantity === "number" && quantity >= 1 ? Math.floor(quantity) : 1;
}

export async function loadAttendeeContext(supabase: Client, lines: AttendeeLine[]): Promise<AttendeeContext> {
  if (lines.length === 0) return { ok: false, message: "Choose at least one ticket." };
  for (const l of lines) {
    if (typeof l.class_id !== "string" || !UUID_RE.test(l.class_id)) {
      return { ok: false, message: "Each ticket must have a valid class_id UUID." };
    }
  }

  const ids = Array.from(new Set(lines.map((l) => l.class_id)));
  const { data: classes, error: classError } = (await supabase
    .from("classes")
    .select("id, intake_id, pack_size")
    .in("id", ids)) as {
    data: { id: string; intake_id: string; pack_size: number | null }[] | null;
    error: unknown;
  };
  if (classError) throw new Error("attendeeContext: classes lookup failed");

  // A class that doesn't exist is the RPC's to refuse (CLASS_NOT_FOUND, 404):
  // no order is created, so there is nothing to ask runners about. Answering
  // here instead would change that response for every event.
  const byId = new Map((classes ?? []).map((c) => [c.id, c]));
  if (ids.some((id) => !byId.has(id))) return { ok: true, fields: [], slots: [] };

  const intakeIds = Array.from(new Set((classes ?? []).map((c) => c.intake_id)));
  const { data: fieldRows, error: fieldError } = (await supabase
    .from("intake_form_fields")
    .select("intake_id, field_key, field_label, field_type, is_required, options")
    .in("intake_id", intakeIds)
    .eq("per_attendee", true)
    .order("sort_order", { ascending: true })
    .order("field_key", { ascending: true })) as {
    data: (AttendeeField & { intake_id: string })[] | null;
    error: unknown;
  };
  if (fieldError) throw new Error("attendeeContext: fields lookup failed");

  // Nothing to ask: no slots either. The RPC still checks the quantity, so a
  // large one is refused there exactly as before this feature.
  if (!fieldRows || fieldRows.length === 0) return { ok: true, fields: [], slots: [] };
  if (intakeIds.length > 1) return { ok: false, message: "Buy tickets for one event at a time." };

  const fields: AttendeeField[] = fieldRows.map((f) => ({
    field_key: f.field_key,
    field_label: f.field_label,
    field_type: f.field_type,
    is_required: f.is_required,
    options: f.options,
  }));

  let slots: AttendeeSlot[];
  try {
    slots = attendeeSlots(
      lines.map((l) => ({
        class_id: l.class_id,
        admissions: normaliseQuantity(l.quantity) * (byId.get(l.class_id)!.pack_size ?? 1),
      })),
    );
  } catch {
    return { ok: false, message: "Too many tickets in one order." };
  }
  return { ok: true, fields, slots };
}

/**
 * Stores validated runners on an order the RPC just returned.
 *
 * The RPCs are idempotent: a retry with the same key returns the EXISTING
 * order, whatever lines the retry sent, and that order may since have been
 * paid. So the runners are written only when the slots rebuilt from the
 * order's own lines are exactly the runners' slots, and only while the order
 * still awaits payment. Otherwise the stored runners are left alone.
 *
 * Never throws: the order exists and holds its seats, so a failure is logged
 * (with the enrollment id only — no names or answers) rather than undoing it.
 * Returns whether the runners were written.
 */
export async function saveAttendees(
  supabase: Client,
  enrollmentId: string,
  orderLines: AttendeeLine[],
  attendees: Attendee[],
): Promise<boolean> {
  if (attendees.length === 0) return false;
  try {
    const ctx = await loadAttendeeContext(supabase, orderLines);
    const key = (s: AttendeeSlot) => `${s.class_id}:${s.seat_no}`;
    const expected = ctx.ok ? ctx.slots.map(key).sort().join(",") : "";
    const given = attendees.map(key).sort().join(",");
    if (!ctx.ok || expected !== given) {
      console.error(`[enroll] runners not saved for enrollment ${enrollmentId}: order lines differ`);
      return false;
    }
    const { error } = (await supabase
      .from("enrollments")
      .update({ attendees } as never)
      .eq("id", enrollmentId)
      .eq("status", "pending_payment")) as { error: { code?: string; message?: string } | null };
    if (error) {
      console.error(`[enroll] runners NOT saved for enrollment ${enrollmentId}:`, error.code ?? "unknown");
      return false;
    }
    return true;
  } catch {
    console.error(`[enroll] runners NOT saved for enrollment ${enrollmentId}: lookup failed`);
    return false;
  }
}

/** Loads the order's context and validates the runners sent with it. */
export async function checkAttendees(supabase: Client, lines: AttendeeLine[], raw: unknown): Promise<AttendeeResult> {
  const ctx = await loadAttendeeContext(supabase, lines);
  if (!ctx.ok) return ctx;
  return validateAttendees(raw, ctx.slots, ctx.fields);
}
