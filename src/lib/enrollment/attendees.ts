// ─── Per-ticket form answers ("runner details") ─────────────────────────────
//
// An organiser can mark a form field "Ask for each ticket". Its answers are
// stored per admission in enrollments.attendees, keyed by (class_id, seat_no)
// — the same key issueTicketsForEnrollment numbers tickets by: seats 1..N per
// class, duplicate lines for one class summed, quantity × pack_size. Keep
// attendeeSlots and that function in step, or a runner lands on the wrong
// ticket.
//
// Pure: used by the browser (to draw and check the cards) and by both server
// write paths (POST /api/public/enroll, PATCH /api/public/enrollment/[ref]).

export interface AttendeeField {
  field_key: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  options: unknown;
}

export interface AttendeeSlot {
  class_id: string;
  seat_no: number;
}

export interface Attendee extends AttendeeSlot {
  answers: Record<string, string>;
  /** Fixed at purchase; printed on the ticket. */
  label: string;
}

export const ANSWER_MAX = 200;

/**
 * Hard ceiling on runners per order, checked BEFORE any loop. The quantity
 * comes from the request and max_tickets_per_person is only checked later,
 * inside the RPC, so without this a forged quantity would size the loop.
 */
export const MAX_ATTENDEES = 50;

const CHOICE_TYPES = new Set(["select", "radio"]);

/** Slots for an order: one per admission (quantity × pack_size), seats 1..N per class. */
export function attendeeSlots(lines: { class_id: string; admissions: number }[]): AttendeeSlot[] {
  const total = lines.reduce((sum, l) => sum + l.admissions, 0);
  if (!Number.isFinite(total) || total > MAX_ATTENDEES) {
    throw new Error("Too many tickets in one order.");
  }
  const byClass = new Map<string, number>();
  for (const l of lines) byClass.set(l.class_id, (byClass.get(l.class_id) ?? 0) + l.admissions);
  const slots: AttendeeSlot[] = [];
  for (const [class_id, n] of Array.from(byClass.entries())) {
    for (let seat_no = 1; seat_no <= n; seat_no++) slots.push({ class_id, seat_no });
  }
  return slots;
}

export type AttendeeResult = { ok: true; attendees: Attendee[] } | { ok: false; message: string };

const INVALID = "Runner details are invalid. Reload the page and try again.";
const INCOMPLETE = "Every ticket needs its runner's details.";

/**
 * Checks the runners sent with an order. With no per-ticket fields the order
 * has no runners and anything sent is ignored, so events that never use this
 * behave exactly as before.
 */
export function validateAttendees(raw: unknown, slots: AttendeeSlot[], fields: AttendeeField[]): AttendeeResult {
  if (fields.length === 0) return { ok: true, attendees: [] };
  // Also what a buyer sees whose page was opened before the organiser flagged
  // a field, so tell them how to recover.
  if (!Array.isArray(raw)) {
    return { ok: false, message: "Runner details are missing. Reload the page and try again." };
  }
  if (raw.length > MAX_ATTENDEES) return { ok: false, message: INVALID };

  const sent = new Map<string, Record<string, unknown>>();
  for (const e of raw) {
    if (!e || typeof e !== "object") return { ok: false, message: INVALID };
    const { class_id, seat_no, answers } = e as Record<string, unknown>;
    if (typeof class_id !== "string" || !Number.isInteger(seat_no)) {
      return { ok: false, message: INVALID };
    }
    sent.set(
      `${class_id}:${seat_no}`,
      answers && typeof answers === "object" ? (answers as Record<string, unknown>) : {},
    );
  }
  if (sent.size !== slots.length || raw.length !== slots.length) return { ok: false, message: INCOMPLETE };

  const attendees: Attendee[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const given = sent.get(`${slot.class_id}:${slot.seat_no}`);
    if (!given) return { ok: false, message: INCOMPLETE };
    const answers: Record<string, string> = {};
    for (const f of fields) {
      const rawValue = given[f.field_key];
      const v = typeof rawValue === "string" ? rawValue.trim() : "";
      if (v.length > ANSWER_MAX) return { ok: false, message: `Runner ${i + 1}: ${f.field_label} is too long.` };
      if (!v) {
        if (f.is_required) return { ok: false, message: `Runner ${i + 1}: ${f.field_label} is required.` };
        continue;
      }
      if (CHOICE_TYPES.has(f.field_type) && Array.isArray(f.options) && !f.options.includes(v)) {
        return { ok: false, message: `Runner ${i + 1}: choose a ${f.field_label} from the list.` };
      }
      answers[f.field_key] = v;
    }
    attendees.push({ ...slot, answers, label: attendeeLabel(answers, fields) });
  }
  return { ok: true, attendees };
}

/** "Ma Su · Kids 8" — the line printed on the e-ticket. */
export function attendeeLabel(answers: Record<string, string>, fields: AttendeeField[]): string {
  return fields
    .map((f) => answers[f.field_key])
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join(" · ");
}

/** Counts per option of a choice field, in the organiser's option order. */
export function attendeeTotals(
  list: { answers: Record<string, string> }[],
  field: AttendeeField,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of list) {
    const v = a.answers[field.field_key];
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const order = Array.isArray(field.options) ? (field.options as string[]) : [];
  // A value the organiser has since removed from the list sorts last.
  const rank = (v: string) => (order.indexOf(v) === -1 ? Number.POSITIVE_INFINITY : order.indexOf(v));
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((x, y) => (rank(x.value) === rank(y.value) ? 0 : rank(x.value) < rank(y.value) ? -1 : 1));
}
