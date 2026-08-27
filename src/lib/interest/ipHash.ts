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
  return ip;
}

export function hashIp(raw: string | null | undefined, secret: string): string {
  return createHmac("sha256", secret).update(canonicalIp(raw)).digest("hex");
}
