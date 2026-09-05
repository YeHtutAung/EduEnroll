import { customOriginForTenant } from "@/lib/tenant";

// ─── Trusted tenant origin ───────────────────────────────────────────────────
// Builds a tenant's public origin from a trusted source — the tenant's own
// subdomain plus the configured app host (NEXT_PUBLIC_APP_URL) — never the
// inbound Host header, which a client can spoof to inject attacker-controlled
// links into outbound notifications (emails / SMS / Telegram).

// ─── Stable platform origin ──────────────────────────────────────────────────
// For machine-to-machine URLs (payment callbacks) that must never point at a
// tenant-controlled domain. Deliberately takes no tenant argument: unlike
// tenantOrigin(), which may become custom-domain-aware, this cannot be made to
// return a host a client can remove or repoint. Removing a custom domain must
// never strand an in-flight payment.

export function platformOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";
  return new URL(configured).origin;
}

export function tenantOrigin(subdomain: string | null | undefined): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";
  const url = new URL(appUrl);
  // Local dev / bare-IP hosts don't use tenant subdomains — return origin as-is.
  if (!subdomain || url.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    return url.origin;
  }

  // `www` is an alias of the platform root, never part of a tenant hostname.
  // Using it as the base would generate `school.www.kuunyi.com`, which is not
  // a configured tenant domain. Keep platformOrigin() unchanged for callers
  // that intentionally need the configured public host.
  const hostname = url.hostname.replace(/^www\./i, "");
  const host = url.port ? `${hostname}:${url.port}` : hostname;
  return `${url.protocol}//${subdomain}.${host}`;
}

// ─── Branded origin for outbound student links ───────────────────────────────
// The tenant's custom domain when one is configured, else the canonical
// kuunyi subdomain. For links a student reads and clicks — confirmation
// emails, Telegram, SMS, interest links — so a buyer who enrolled on
// loudermyanmar.com is not sent back to brave.kuunyi.com.
//
// Deliberately NOT folded into tenantOrigin(). Callers that need the canonical
// subdomain specifically must not follow a custom domain:
//
//   - the payment return-URL allowlist seeds itself with the canonical origin
//     and adds the custom one separately. Making these one value would drop
//     brave.kuunyi.com from the allowlist and 400 a student who legitimately
//     arrived there — a custom domain is an alias, not a replacement.
//   - machine callbacks use platformOrigin() and must never touch
//     tenant-controlled DNS at all.
//
// Same trust boundary as tenantOrigin(): the slug is ours and the domain map is
// an operator-set environment variable. Never the inbound Host header.
export function tenantLinkOrigin(subdomain: string | null | undefined): string {
  if (subdomain) {
    const custom = customOriginForTenant(subdomain);
    if (custom) return custom;
  }
  return tenantOrigin(subdomain);
}
