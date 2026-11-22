/**
 * CSRF hardening for cookie-authenticated POSTs: the cookie rides along on
 * cross-site requests, so refuse a browser request that isn't same-origin.
 * sec-fetch-site cross-site or same-site (a sibling tenant subdomain), or an
 * Origin whose host isn't this request's Host, is refused. With neither header
 * (not a browser) it's allowed: the cookie is still needed.
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const host = request.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return !!host && originHost.toLowerCase() === host.toLowerCase();
}
