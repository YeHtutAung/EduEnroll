// ─── Host classification ────────────────────────────────────────────────────

/**
 * Hosts that only ever appear in development: the local machine, LAN testing,
 * or a Vercel preview deployment. Never a production host.
 *
 * Exported and shared on purpose. The HitPay redirect allowlist and the tenant
 * middleware need the identical rule, and two divergent host classifiers is the
 * kind of drift that makes a security check pass in one place and fail in
 * another. Import this; do not re-inline it.
 */
export function isDevHost(hostname: string): boolean {
  const host = hostname.split(":")[0].trim().toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.endsWith(".vercel.app")
  );
}

// ─── Extract subdomain from host header ─────────────────────────────────────
// Shared helper used by server components as a fallback when middleware's
// x-tenant-slug header doesn't propagate on Vercel.

export function extractSubdomainFromHost(host: string): string | null {
  const hostname = host.split(":")[0];
  const parts = hostname.split(".");

  // "nihon-moment.localhost" → "nihon-moment"
  if (parts.length === 2 && parts[1] === "localhost") return parts[0];

  // "tmf.kuunyi.com" → "tmf"
  // "tmf.staging.kuunyi.com" → "tmf"
  if (hostname.endsWith(".kuunyi.com")) {
    const sub = parts[0];
    return sub && sub !== "www" && sub !== "staging" ? sub : null;
  }

  // "nihon-moment.edu-enroll-xi.vercel.app" → "nihon-moment"
  if (hostname.endsWith(".vercel.app")) return parts.length >= 4 ? parts[0] : null;

  return parts.length >= 3 ? parts[0] : null;
}
