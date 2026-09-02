// ─── Browser-safe random identifier ─────────────────────────────────────────
//
// `crypto.randomUUID()` is only defined in a SECURE CONTEXT — HTTPS, or
// localhost. Over plain HTTP it is undefined, and calling it throws:
//
//   TypeError: crypto.randomUUID is not a function
//
// That makes the enrolment form unusable on any device reaching a dev server
// by LAN address, which is exactly how the flow gets tested on a phone. It
// never affects production, which is HTTPS throughout, so it hides until
// someone tests on real hardware.
//
// `crypto.getRandomValues()` has no secure-context requirement, so a UUIDv4
// can be assembled from it wherever `randomUUID` is missing.

/**
 * A RFC 4122 version 4 identifier, in any browsing context.
 *
 * Prefers the native implementation; falls back to `getRandomValues`, and
 * finally to `Math.random` on anything ancient enough to lack both. The last
 * step is not cryptographically strong — acceptable here because the callers
 * need uniqueness (idempotency keys), not unpredictability. Do not reach for
 * this to mint a secret.
 */
export function randomId(): string {
  const c: Crypto | undefined = globalThis.crypto;

  if (typeof c?.randomUUID === "function") return c.randomUUID();

  const bytes = new Uint8Array(16);

  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Version 4, variant 10xx — what makes it a valid v4 rather than 16 random
  // bytes wearing a UUID's punctuation.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
