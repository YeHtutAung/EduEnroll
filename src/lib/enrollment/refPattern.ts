// ─── What an enrollment reference looks like ─────────────────────────────────
//
// One definition, imported by every channel that accepts a reference typed or
// pasted by a customer.
//
// There used to be three copies — the Messenger processor and both Telegram
// processors — and they drifted: two accepted a 1-5 character prefix while one
// accepted only 1-4. The prefix is built from the tenant's name initials, so
// its length is a property of the tenant, not of the reference. A tenant whose
// name was long enough therefore had references its own Messenger bot silently
// refused to recognise: no error, no log, just a customer pasting a reference
// and getting the fallback help text instead of their status.
//
// Bound derivation, so the next person does not have to guess:
// `enrollments.enrollment_ref` is varchar(20) and a reference is
// PREFIX-MMDD-RANDOM. The shortest random part the generator has ever emitted
// is four characters, so an existing row can carry a prefix of up to
// 20 - 1 - 4 - 1 - 4 = 10 characters. The random part itself is capped at six
// by the generator; see supabase/migrations/*_wider_enrollment_ref.sql, which
// treats this pattern as the ceiling it must not exceed.
//
// Case-insensitive because the Messenger processor tests the customer's raw
// text. Both Telegram processors uppercase before testing, for which the flag
// is a no-op.
//
// NO `g` OR `y` FLAG. Those make RegExp.test() stateful through lastIndex, and
// this object is shared across call sites — a match in one processor would
// then change the verdict of the next call somewhere else.

export const ENROLLMENT_REF_PATTERN = /^[A-Z]{1,10}-\d{4}-[A-Z0-9]{3,6}$/i;

/**
 * True when `text` has the shape of an enrollment reference.
 *
 * Shape only: it says nothing about whether the reference exists, belongs to
 * this tenant, or is still live. Callers look it up before acting on it.
 */
export function isEnrollmentRef(text: string): boolean {
  return ENROLLMENT_REF_PATTERN.test(text);
}
