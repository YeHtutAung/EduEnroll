// ─── Host → tenant resolution ───────────────────────────────────────────────
// The single canonical resolver. Server components use it as a fallback when
// middleware's x-tenant-slug header doesn't propagate on Vercel, and middleware
// imports it too. Do not add a second copy — a divergent duplicate is how a
// custom domain ends up resolving on some requests and not others.
//
// This is an allowlist. A host resolves to a tenant only if it is a kuunyi
// subdomain, a Vercel preview, localhost, or explicitly configured below.
// Never infer a tenant from an arbitrary hostname: Vercel's domain assignment
// should not be the only thing preventing "flashtic.evil.com" from resolving.

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

// ─── Tenant custom domains ──────────────────────────────────────────────────
// Maps a client-owned domain ("flashtic.com") to the tenant slug that owns it
// ("flashtic"), configured via TENANT_CUSTOM_DOMAINS as JSON host → slug:
//   {"flashtic.com":"flashtic"}
// The tenant keeps its canonical kuunyi subdomain; the custom domain is an
// additional student-facing alias.

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_HOSTS = new Set(["kuunyi.com", "localhost", "vercel.app"]);

// Host header → bare comparable hostname: strip port, lowercase, drop the FQDN
// trailing dot, fold www.
function normalizeHost(host: string): string {
  return host
    .split(":")[0]
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

export interface DomainMapIssue {
  /** 1-based position in the JSON object. */
  entry: number;
  /** Normalized host, when one could be derived — lets the preflight name the
   *  offending entry without reparsing. Runtime never logs it. */
  host?: string;
  reason: string;
}

export interface ParsedTenantDomains {
  map: Map<string, string>;
  issues: DomainMapIssue[];
}

/**
 * The only implementation of parsing, normalization, validation, reserved-host
 * and uniqueness checks. Exported so the preflight script validates with the
 * exact same code the runtime uses — two parsers would eventually disagree, and
 * a preflight that passes while runtime rejects is worse than none.
 *
 * Pure: takes the raw string, touches no process.env, never throws.
 *
 * A Map (not a plain object) is deliberate: object lookup resolves prototype
 * keys, so a Host of "constructor" would return a truthy value.
 */
export function parseTenantCustomDomains(raw: string): ParsedTenantDomains {
  const map = new Map<string, string>();
  const issues: DomainMapIssue[] = [];

  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // No custom domains rather than no platform.
    return { map, issues: [{ entry: 0, reason: "not valid JSON" }] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return raw.trim()
      ? { map, issues: [{ entry: 0, reason: "not a JSON object of host → slug" }] }
      : { map, issues };
  }

  const claimed = new Set<string>();
  let n = 0;

  for (const [rawHost, rawSlug] of Object.entries(parsed as Record<string, unknown>)) {
    n++;
    const host = normalizeHost(rawHost);
    const fail = (reason: string) => issues.push({ entry: n, host, reason });

    if (typeof rawSlug !== "string") {
      fail("slug is not a string");
      continue;
    }
    const slug = rawSlug.trim().toLowerCase();

    if (!HOST_RE.test(host)) fail("malformed hostname");
    else if (!SLUG_RE.test(slug)) fail("malformed tenant slug");
    // A custom domain must never claim the platform's own hosts.
    else if (
      RESERVED_HOSTS.has(host) ||
      host.endsWith(".kuunyi.com") ||
      host.endsWith(".vercel.app")
    )
      fail("reserved platform host");
    else if (map.has(host)) fail("duplicate host");
    // One domain per tenant: a reverse lookup would otherwise be ambiguous.
    else if (claimed.has(slug)) fail("tenant already has a custom domain");
    else {
      claimed.add(slug);
      map.set(host, slug);
      continue;
    }
  }

  return { map, issues };
}

let cachedRaw: string | undefined;
let cachedMap = new Map<string, string>();

// Memoised on the raw string: production parses once, tests can mutate
// process.env freely. Must never throw — this runs on every request to every
// domain, so a parse error over one tenant's typo would 500 the platform.
function domainMap(): Map<string, string> {
  const raw = process.env.TENANT_CUSTOM_DOMAINS ?? "";
  if (raw === cachedRaw) return cachedMap;
  cachedRaw = raw;

  const { map, issues } = parseTenantCustomDomains(raw);

  // Counts only. Hosts and slugs come from an env var and must not be written
  // to shared logs; scripts/verify-custom-domains.ts prints the detail locally,
  // where an operator asked for it explicitly.
  if (issues.length > 0) {
    console.warn(
      `[tenant-domains] Ignored ${issues.length} invalid TENANT_CUSTOM_DOMAINS entr${
        issues.length === 1 ? "y" : "ies"
      }; ${map.size} active. Run scripts/verify-custom-domains.ts.`,
    );
  }

  cachedMap = map;
  return cachedMap;
}

/** Tenant slug that owns this host, or null if it is not a configured custom domain. */
export function tenantForCustomHost(host: string): string | null {
  return domainMap().get(normalizeHost(host)) ?? null;
}

// ─── Extract subdomain from host header ─────────────────────────────────────

export function extractSubdomainFromHost(host: string): string | null {
  // Custom domains resolve first. This must precede everything below: a 2-part
  // host like "flashtic.com" would otherwise fall through to the null return.
  const custom = tenantForCustomHost(host);
  if (custom) return custom;

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

  // Every other host must be explicitly configured above. Do not infer.
  return null;
}
