/**
 * Mailbox providers buyers actually use. A domain one typing slip away from one
 * of these is probably a typo.
 */
const COMMON_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "live.com",
  "protonmail.com",
];

/** Real domains that sit one slip away from a common one, so never "corrected". */
const REAL_LOOKALIKES = new Set(["mail.com", "email.com", "ymail.com", "gmx.com", "me.com", "msn.com"]);

/** Endings that are no real top-level domain and are slips for ".com". */
const COM_TYPOS = new Set(["con", "cmo", "ocm", "vom", "xom", "cim", "comm", "coom"]);

// Commas, semicolons and angle brackets would let one value name several
// recipients or a display name when it is handed to the email provider.
const EMAIL_SHAPE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>".]+$/;
const MAX_EMAIL_LENGTH = 254;

export function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(email);
}

/** True when `a` becomes `b` with one insert, delete, replace or neighbour swap. */
function isOneSlipAway(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

  const restA = a.slice(start);
  const restB = b.slice(start);
  return (
    restA.slice(1) === restB.slice(1) ||
    restA.slice(1) === restB ||
    restA === restB.slice(1) ||
    (restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2))
  );
}

/**
 * The address the buyer probably meant, or null when nothing looks wrong. This
 * only ever suggests: an unusual address can still be real, so no caller may
 * refuse an address because of it.
 */
export function suggestEmailCorrection(email: string): string | null {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;

  const local = trimmed.slice(0, at);
  const typed = trimmed.slice(at + 1).toLowerCase();

  const lastDot = typed.lastIndexOf(".");
  const ending = lastDot === -1 ? "" : typed.slice(lastDot + 1);
  const domain = COM_TYPOS.has(ending) ? `${typed.slice(0, lastDot)}.com` : typed;

  if (COMMON_DOMAINS.includes(domain) || REAL_LOOKALIKES.has(domain)) {
    return domain === typed ? null : `${local}@${domain}`;
  }

  const closest = COMMON_DOMAINS.find((common) => isOneSlipAway(domain, common));
  if (closest) return `${local}@${closest}`;

  return domain === typed ? null : `${local}@${domain}`;
}

/**
 * Stops a form once for each address that looks mistyped, and lets the same
 * address through on the next try, so a buyer whose address really is unusual
 * can continue. `warned` is the form's own memory of what it has already queried.
 */
export function emailTypoToConfirm(email: string, warned: Set<string>): string | null {
  const value = email.trim();
  const suggestion = suggestEmailCorrection(value);
  if (!suggestion || warned.has(value)) return null;
  warned.add(value);
  return suggestion;
}

/**
 * The order's saved answers with the old address swapped for the new one. Only
 * values equal to the old address change, so a second email field holding someone
 * else's address is left alone.
 */
export function replaceEmailInFormData(
  formData: Record<string, unknown> | null | undefined,
  oldEmail: string,
  newEmail: string,
): Record<string, unknown> {
  const old = oldEmail.trim().toLowerCase();
  return Object.fromEntries(
    Object.entries(formData ?? {}).map(([key, value]) => [
      key,
      typeof value === "string" && value.trim().toLowerCase() === old ? newEmail : value,
    ]),
  );
}
