// ─── Payment return-URL allowlist ────────────────────────────────────────────
// A customer return URL is client-supplied and must be validated server-side:
// an unchecked value turns a genuine payment link into a phishing redirect.
//
// Machine callbacks are a different problem with the opposite answer — they pin
// to the platform origin and never follow the client.

import { tenantOrigin } from "@/lib/origin";
import { customOriginForTenant, isDevHost } from "@/lib/tenant";

/** Origins where a legitimate enrollment page for this tenant can live. */
function allowedOrigins(tenantSubdomain: string, requestOrigin: string): Set<string> {
  // Canonical origin, derived from NEXT_PUBLIC_APP_URL — never the inbound Host.
  // The platform root is deliberately NOT here: no enrollment page exists on
  // kuunyi.com, so allowing it would widen the allowlist for nothing.
  const origins = new Set<string>([tenantOrigin(tenantSubdomain)]);

  // The tenant's own custom domain, when configured. Scoped to THIS tenant by
  // construction — the lookup is by slug, so another tenant's domain can never
  // appear here. Unlike the dev-host exception below, this applies in
  // production: serving students on a branded domain is the entire point.
  const custom = customOriginForTenant(tenantSubdomain);
  if (custom) origins.add(custom);

  // Off production, also allow the origin the request arrived on — but ONLY if
  // it is a recognized dev host. tenantOrigin() derives from
  // NEXT_PUBLIC_APP_URL, which on a preview deployment does not point at the
  // preview host, so without this every preview card return would 400.
  //
  // The hostname check is not optional: without it the request origin allows
  // ITSELF, and a preview receiving `Host: evil.com` would accept a redirect to
  // https://evil.com. VERCEL_ENV alone is not a control.
  if (process.env.VERCEL_ENV !== "production") {
    try {
      if (isDevHost(new URL(requestOrigin).hostname)) origins.add(requestOrigin);
    } catch {
      // An unparseable request origin contributes nothing.
    }
  }

  return origins;
}

/**
 * True only if `candidate` is a well-formed absolute URL whose origin is
 * allowlisted for this tenant. Never throws.
 */
export function isAllowedRedirect(
  candidate: string,
  tenantSubdomain: string,
  requestOrigin: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate); // throws on relative/malformed input
  } catch {
    return false;
  }

  // URL.origin discards credentials, so "https://user:pass@good.com" would
  // otherwise pass while the browser renders a credential-stuffed URL.
  if (parsed.username || parsed.password) return false;

  // Exact origin match. Never startsWith: "https://good.com.evil.com" is a
  // prefix of "https://good.com". Origin covers scheme, host and port, so an
  // http:// candidate cannot match an https:// allowed origin.
  return allowedOrigins(tenantSubdomain, requestOrigin).has(parsed.origin);
}
