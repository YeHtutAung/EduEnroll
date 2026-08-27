// Pseudonymised client address for the signup rate limiter.
//
// Keyed HMAC rather than sha256(ip + salt): concatenation leaves the
// delimiter and ordering as unstated convention that a later edit can change
// without anyone noticing, which silently resets every bucket.
//
// This is a cost and reputation control, NOT an authorization boundary.
// Forwarded headers are attacker-influenced.
import { createHmac } from "crypto";

export function canonicalIp(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  let ip = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!ip) return "unknown";
  ip = ip.toLowerCase();
  // IPv4-mapped IPv6 and one client must not occupy two buckets.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  // Callers pass a bare address (NextRequest.ip, or the first x-forwarded-for
  // entry), so a port suffix or a non-compressed IPv6 literal is not expected
  // and is not normalised here. Either would land in its own bucket — the
  // limiter degrades, never breaks. Worth re-checking behind a different proxy.
  return ip;
}

export function hashIp(raw: string | null | undefined, secret: string): string {
  if (!secret) {
    throw new Error("hashIp: secret must be a non-empty string");
  }
  return createHmac("sha256", secret).update(canonicalIp(raw)).digest("hex");
}
