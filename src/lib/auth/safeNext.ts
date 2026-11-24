// ─── safeNext: where /auth/callback may send the buyer afterwards ───────────
//
// Only a path on this same origin: one leading "/", never "//" or a
// backslash (browsers read "/\evil" as "//evil"), no scheme, no control
// characters (a value starting with a single "/" can't carry a scheme).
// Percent-encoding is decoded first, repeatedly, so a double-encoded "%252F"
// can't slip through, and every decoded form is checked too. Anything else, including malformed encoding, is /account. No open
// redirect.

export const DEFAULT_NEXT = "/account";

const MAX_LENGTH = 2048;
// C0 controls, DEL, and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function isSafePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !CONTROL.test(path)
  );
}

export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_LENGTH) return DEFAULT_NEXT;
  if (!isSafePath(raw)) return DEFAULT_NEXT;

  // Every decoding of the value must be safe too, and so must every "//" or
  // "\" it could turn into.
  let current = raw;
  for (let i = 0; i < 5; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return DEFAULT_NEXT;
    }
    if (!isSafePath(decoded) || decoded.includes("//")) return DEFAULT_NEXT;
    if (decoded === current) return raw;
    current = decoded;
  }
  // Still decoding after five rounds: not a path anyone typed.
  return DEFAULT_NEXT;
}
