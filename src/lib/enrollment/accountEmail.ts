// ─── Which form answers are a protected order's email ───────────────────────
// Account-bound tickets (design 5.2): a protected order's email is the
// account's. The server overwrites these answers with it (withAccountEmail in
// src/server/enrollment/protection.ts) and the form and checkout pages lock
// exactly these fields, so the two always agree. They are the keys the order
// and its emails read an address from (resolveEmailFromFormData).
//
// Browser-safe: no server imports.

/** email, email_address and custom_email_* (the organiser's custom email fields). */
export function isAccountEmailKey(key: string): boolean {
  return key === "email" || key === "email_address" || key.startsWith("custom_email_");
}

/**
 * The email a protected order's locked fields show. `sessionEmail` is the
 * signed-in buyer's (null when the page isn't a protected, signed-in one, so
 * nothing is locked). An existing order shows its own stored email, which the
 * server keeps whoever is signed in now; the session's only fills in when the
 * order has none.
 */
export function lockedOrderEmail(
  orderEmail: string | null | undefined,
  sessionEmail: string | null,
): string | null {
  if (sessionEmail === null) return null;
  const stored = typeof orderEmail === "string" ? orderEmail.trim() : "";
  return stored || sessionEmail;
}
