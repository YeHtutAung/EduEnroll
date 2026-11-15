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
    // Lower-case: slots carry the database's canonical (lower-case) UUIDs.
    sent.set(
      `${class_id.toLowerCase()}:${seat_no}`,
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

/**
 * Field types whose answer is one short string, so they can be asked once per
 * ticket. Mirrors the CHECK intake_form_fields_per_attendee_type
 * (20261115120000): a checkbox's "false" would pass "required", and a file has
 * no per-ticket upload path.
 */
export const PER_ATTENDEE_TYPES: readonly string[] = ["text", "select", "radio", "date", "phone"];

/**
 * Why a field can't be asked per ticket, or null when it can. Contact fields
 * (is_default) are the buyer's and are asked once per order. The database
 * enforces both rules; this gives the editor a readable answer first.
 */
export function perAttendeeProblem(field: { field_type: string; is_default: boolean }): string | null {
  if (field.is_default) return "Contact fields are asked once per order.";
  if (!PER_ATTENDEE_TYPES.includes(field.field_type)) return "This kind of field can't be asked per ticket.";
  return null;
}

// ─── Browser helpers for the runner cards ───────────────────────────────────

/** "class_id:seat_no" — how runner cards and their answers are keyed. */
export function slotKey(slot: AttendeeSlot): string {
  return `${slot.class_id}:${slot.seat_no}`;
}

/**
 * Per-card, per-field messages for the runner cards, so every problem shows at
 * once. Same rules as validateAttendees (which the server applies and which
 * stays the authority); an empty result means the cards are complete.
 */
export function attendeeFieldErrors(
  values: Record<string, Record<string, string>>,
  slots: AttendeeSlot[],
  fields: AttendeeField[],
): Record<string, Record<string, string>> {
  const errors: Record<string, Record<string, string>> = {};
  for (const slot of slots) {
    const key = slotKey(slot);
    const answers = values[key] ?? {};
    for (const f of fields) {
      const v = (answers[f.field_key] ?? "").trim();
      let message: string | null = null;
      if (!v) {
        if (f.is_required) message = `${f.field_label} is required.`;
      } else if (v.length > ANSWER_MAX) {
        message = `${f.field_label} is too long.`;
      } else if (CHOICE_TYPES.has(f.field_type) && Array.isArray(f.options) && !f.options.includes(v)) {
        message = `Choose a ${f.field_label} from the list.`;
      }
      if (message) (errors[key] ??= {})[f.field_key] = message;
    }
  }
  return errors;
}

/** The `attendees` array sent with an order, in slot order. */
export function attendeesPayload(
  values: Record<string, Record<string, string>>,
  slots: AttendeeSlot[],
  fields: AttendeeField[],
): { class_id: string; seat_no: number; answers: Record<string, string> }[] {
  return slots.map((slot) => {
    const given = values[slotKey(slot)] ?? {};
    const answers: Record<string, string> = {};
    for (const f of fields) {
      const v = (given[f.field_key] ?? "").trim();
      if (v) answers[f.field_key] = v;
    }
    return { class_id: slot.class_id, seat_no: slot.seat_no, answers };
  });
}

// ─── Admin views ────────────────────────────────────────────────────────────

export interface RunnerRow {
  class_id: string;
  seat_no: number;
  /** Tier name, from the order's own lines. */
  tier: string;
  label: string;
  answers: Record<string, string>;
}

/**
 * enrollments.attendees as rows for the admin pages, in seat order. Defensive:
 * an entry that isn't the stored shape is skipped rather than breaking the
 * page.
 */
export function runnerRows(attendees: unknown, tierOf: (classId: string) => string): RunnerRow[] {
  if (!Array.isArray(attendees)) return [];
  const rows: RunnerRow[] = [];
  for (const a of attendees) {
    if (!a || typeof a !== "object") continue;
    const { class_id, seat_no, label, answers } = a as Record<string, unknown>;
    if (typeof class_id !== "string" || !Number.isInteger(seat_no)) continue;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) continue;
    rows.push({
      class_id,
      seat_no: seat_no as number,
      tier: tierOf(class_id),
      label: typeof label === "string" ? label : "",
      answers: answers as Record<string, string>,
    });
  }
  return rows.sort((x, y) => x.class_id.localeCompare(y.class_id) || x.seat_no - y.seat_no);
}

/**
 * Totals per option of a per-ticket choice field across orders, for the
 * export's "Sizes" sheet. An order with runners counts each runner. An order
 * from before the organiser switched the field to per-ticket has no runners
 * and its one answer in form_data: it counts once, or the totals would miss
 * every earlier buyer.
 */
export function orderTotals(
  orders: { attendees: unknown; form_data: Record<string, string> | null }[],
  field: AttendeeField,
): { value: string; count: number }[] {
  const answers: { answers: Record<string, string> }[] = [];
  for (const o of orders) {
    // Per field, not per order: an order can have runners for one question
    // (name) while this one (size) was still asked once, in form_data, when
    // it was placed.
    const withField = runnerRows(o.attendees, () => "").filter((r) => r.answers[field.field_key]);
    if (withField.length > 0) {
      for (const r of withField) answers.push({ answers: r.answers });
    } else if (o.form_data?.[field.field_key]) {
      answers.push({ answers: { [field.field_key]: o.form_data[field.field_key] } });
    }
  }
  return attendeeTotals(answers, field);
}

/**
 * The Runners sheet's answer cells for one order: one row per runner, or one
 * row for an order with no runners. A field no runner answered keeps the
 * order's form_data answer (asked once, before the field was switched to
 * per-ticket) on the FIRST row only, so it is shown but not multiplied across
 * tickets — the same rule orderTotals counts by.
 */
export function runnerExportCells(
  runners: { answers: Record<string, string> }[],
  formData: Record<string, string> | null,
  fields: { field_key: string }[],
): string[][] {
  if (runners.length === 0) {
    if (!fields.some((f) => formData?.[f.field_key])) return [];
    return [fields.map((f) => formData?.[f.field_key] ?? "")];
  }
  const answeredByRunner = new Set(
    fields.filter((f) => runners.some((r) => r.answers[f.field_key])).map((f) => f.field_key),
  );
  return runners.map((r, i) =>
    fields.map((f) =>
      answeredByRunner.has(f.field_key)
        ? (r.answers[f.field_key] ?? "")
        : i === 0
        ? (formData?.[f.field_key] ?? "")
        : "",
    ),
  );
}
