// ─── Custom form fields on the interest signup ──────────────────────────────
//
// The interest form always asks for name, email and phone — those live in
// their own event_interest columns. Beyond them it shows the organiser's
// CUSTOM fields from the event's Enrolment Form (intake_form_fields with
// is_default = false), and the answers are stored in event_interest.form_data.
//
// Excluded, and why:
//   - Default fields (name_en, name_mm, nrc, phone, email). Name, email and
//     phone are already asked; NRC and the Myanmar name stay on the purchase
//     form so a head-start signup is a quick ask, not the full enrolment.
//   - `file` fields. The interest signup has no upload path, and the purchase
//     form will still collect the file.
//
// The public page and the API route both import this, so the fields a visitor
// is shown and the fields the server accepts cannot drift apart.

/** The intake_form_fields columns this module needs. */
export interface InterestFieldDef {
  field_key: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  options: unknown;
  is_default: boolean;
}

/**
 * Per-answer cap. Mirrors nothing in the schema directly — the database caps
 * the whole object (see FORM_DATA_MAX_BYTES) — but no single answer on a
 * signup form has a reason to be longer, and it keeps one field from eating
 * the whole budget.
 */
export const INTEREST_ANSWER_MAX = 500;

/**
 * Mirrors CHECK event_interest_form_data_size in
 * 20261019120000_interest_form_data.sql, measured the same way (UTF-8 bytes of
 * the JSON text), so an oversized submission is a 400 here rather than an
 * opaque write failure there.
 */
export const FORM_DATA_MAX_BYTES = 16384;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The custom fields the interest form shows, in the order given. */
export function interestCustomFields<T extends Pick<InterestFieldDef, "is_default" | "field_type">>(
  fields: T[],
): T[] {
  return fields.filter((f) => !f.is_default && f.field_type !== "file");
}

/** A field's options as strings. `options` is jsonb, so it is not trusted to be an array. */
export function fieldOptions(field: Pick<InterestFieldDef, "options">): string[] {
  return Array.isArray(field.options)
    ? field.options.filter((o): o is string => typeof o === "string")
    : [];
}

export type InterestFormDataResult =
  | { ok: true; data: Record<string, string> }
  | { ok: false; message: string };

/**
 * Validates a submitted `form_data` object against the event's custom fields
 * and returns the cleaned answers.
 *
 * - Only keys belonging to a shown custom field are kept; anything else is
 *   dropped, so a caller cannot write arbitrary keys into the row.
 * - Empty answers are omitted rather than stored as "".
 * - select / radio answers must be one of the field's options.
 *
 * Pure: no I/O, never throws.
 */
export function validateInterestFormData(
  fields: InterestFieldDef[],
  raw: unknown,
): InterestFormDataResult {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, message: "form_data must be an object." };
  }
  const submitted = (raw ?? {}) as Record<string, unknown>;
  const data: Record<string, string> = {};

  for (const field of interestCustomFields(fields)) {
    // Own properties only: a key of "constructor" must not read the prototype.
    const value = Object.prototype.hasOwnProperty.call(submitted, field.field_key)
      ? submitted[field.field_key]
      : undefined;

    if (value !== undefined && value !== null && typeof value !== "string") {
      return { ok: false, message: `${field.field_label} must be text.` };
    }
    const answer = typeof value === "string" ? value.trim() : "";

    if (!answer) {
      if (field.is_required) return { ok: false, message: `${field.field_label} is required.` };
      continue;
    }
    if (answer.length > INTEREST_ANSWER_MAX) {
      return {
        ok: false,
        message: `${field.field_label} must be at most ${INTEREST_ANSWER_MAX} characters.`,
      };
    }

    switch (field.field_type) {
      case "select":
      case "radio":
        if (!fieldOptions(field).includes(answer)) {
          return { ok: false, message: `Choose one of the options for ${field.field_label}.` };
        }
        break;
      case "checkbox":
        if (answer !== "true") {
          return { ok: false, message: `${field.field_label} has an invalid value.` };
        }
        break;
      case "date":
        if (!DATE_RE.test(answer)) {
          return { ok: false, message: `${field.field_label} must be a date.` };
        }
        break;
      case "email":
        if (!EMAIL_RE.test(answer)) {
          return { ok: false, message: `${field.field_label} must be a valid email address.` };
        }
        break;
    }

    data[field.field_key] = answer;
  }

  if (new TextEncoder().encode(JSON.stringify(data)).length > FORM_DATA_MAX_BYTES) {
    return { ok: false, message: "Your answers are too long." };
  }

  return { ok: true, data };
}
