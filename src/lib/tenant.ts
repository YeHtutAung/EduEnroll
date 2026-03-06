// ─── Extract subdomain from host header ─────────────────────────────────────
// Shared helper used by server components as a fallback when middleware's
// x-tenant-slug header doesn't propagate on Vercel.

export function extractSubdomainFromHost(host: string): string | null {
  const hostname = host.split(":")[0];
  const parts = hostname.split(".");

  // "nihon-moment.localhost" → "nihon-moment"
  if (parts.length === 2 && parts[1] === "localhost") return parts[0];

  // "nihon-moment.kuunyi.com" → "nihon-moment"
  if (hostname.endsWith(".kuunyi.com")) {
    const sub = parts.slice(0, parts.length - 2).join(".");
    return sub && sub !== "www" ? sub : null;
  }

  // "nihon-moment.edu-enroll-xi.vercel.app" → "nihon-moment"
  if (hostname.endsWith(".vercel.app")) return parts.length >= 4 ? parts[0] : null;

  return parts.length >= 3 ? parts[0] : null;
}
