// ─── Trusted tenant origin ───────────────────────────────────────────────────
// Builds a tenant's public origin from a trusted source — the tenant's own
// subdomain plus the configured app host (NEXT_PUBLIC_APP_URL) — never the
// inbound Host header, which a client can spoof to inject attacker-controlled
// links into outbound notifications (emails / SMS / Telegram).

export function tenantOrigin(subdomain: string | null | undefined): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";
  const url = new URL(appUrl);
  // Local dev / bare-IP hosts don't use tenant subdomains — return origin as-is.
  if (
    !subdomain ||
    url.hostname === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
  ) {
    return url.origin;
  }
  return `${url.protocol}//${subdomain}.${url.host}`;
}
