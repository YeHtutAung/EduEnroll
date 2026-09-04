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
