// ─── Per-tenant Google Tag Manager: pure rules ──────────────────────────────
//
// One module holds the rules, used by the admin API, the client component and
// the tests (same idea as eventFont.ts). It imports nothing from Next or
// Supabase. See docs/superpowers/specs/2026-10-30-tenant-gtm-design.md.
//
// The container ID is written into a script snippet, so only a value that
// passes GTM_CONTAINER_ID_RE may ever be interpolated. It mirrors the CHECK
// constraint on tenants.gtm_container_id.

import { tenantForCustomHost } from "@/lib/tenant";

export const GTM_CONTAINER_ID_RE = /^GTM-[A-Z0-9]{4,12}$/;

/** Trims and uppercases. Blank or null becomes null; anything malformed is "invalid". */
export function normalizeGtmContainerId(input: unknown): string | null | "invalid" {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string") return "invalid";
  const v = input.trim().toUpperCase();
  if (v === "") return null;
  return GTM_CONTAINER_ID_RE.test(v) ? v : "invalid";
}

/**
 * Pages where GTM may run: the event list, an event landing page and its
 * tickets page. Everything past the buyer's commitment (form, payment,
 * checkout, status, interest) is excluded. Tolerates a trailing slash.
 */
export function isTrackedPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "enroll") return false;
  if (parts.length === 1) return true;
  const seg = parts[1];
  if (seg === "form" || seg === "payment") return false;
  if (parts.length === 2) return true;
  return parts.length === 3 && parts[2] === "tickets";
}

/**
 * In production GTM runs only on the tenant's own custom domain, never on the
 * shared kuunyi.com subdomain. Outside production any host is allowed.
 */
export function gtmAllowedOnHost(args: {
  host: string;
  tenantSlug: string;
  isProduction: boolean;
}): boolean {
  if (!args.isProduction) return true;
  return tenantForCustomHost(args.host) === args.tenantSlug;
}

/** Query parameters that carry a ref, token or session: their presence blocks GTM. */
export const SENSITIVE_PARAMS = [
  "psid",
  "ref",
  "cart_key",
  "pi",
  "payment_intent",
  "session_id",
];

/**
 * Storage keys that are provably harmless. This is an ALLOWLIST: any other key
 * in sessionStorage or localStorage blocks GTM.
 *
 * - cart_<timestamp>: the ticket cart stash (class ids, quantities, fees,
 *   image URLs). No ref, token, secret or personal data.
 *
 * Deliberately NOT here: pa_<slug> (priority-access token), cs_<ref> (Stripe
 * client secret), ck_<cart_key> (cart idempotency key, which can be exchanged
 * for an enrollment ref).
 */
export const SAFE_STORAGE_KEYS: RegExp[] = [/^cart_\d+$/];

interface KeyedStorage {
  readonly length: number;
  key(index: number): string | null;
}

function storageIsClean(s: KeyedStorage): boolean {
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const k = s.key(i);
    if (k === null) continue;
    if (!SAFE_STORAGE_KEYS.some((re) => re.test(k))) return false;
  }
  return true;
}

/**
 * True only when nothing sensitive is visible to a third-party script: no
 * sensitive query param, no priority token in the hash, only allowlisted
 * storage keys, and no Supabase auth cookie. Any error counts as not clean.
 */
export function isBrowserStateClean(args: {
  location: { search: string; hash: string };
  sessionStorage: KeyedStorage;
  localStorage: KeyedStorage;
  cookie: string;
}): boolean {
  try {
    const query = new URLSearchParams(args.location.search);
    if (SENSITIVE_PARAMS.some((p) => query.has(p))) return false;

    const hash = new URLSearchParams(args.location.hash.replace(/^#/, ""));
    if (hash.has("pa")) return false;

    if (!storageIsClean(args.sessionStorage)) return false;
    if (!storageIsClean(args.localStorage)) return false;

    const cookieNames = args.cookie
      .split(";")
      .map((c) => c.split("=")[0].trim())
      .filter(Boolean);
    if (cookieNames.some((n) => n.startsWith("sb-"))) return false;

    return true;
  } catch {
    return false;
  }
}

type DataLayerWindow = Window & {
  dataLayer?: Record<string, unknown>[];
  google_tag_manager?: unknown;
};

/**
 * Queues an event on window.dataLayer, creating it if needed. Never a no-op:
 * events pushed before GTM starts are kept and replayed by GTM. The leading
 * { ecommerce: null } is the GA4 convention so ecommerce objects don't merge.
 */
export function pushDataLayer(event: string, payload: Record<string, unknown>): void {
  const w = window as DataLayerWindow;
  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push({ ecommerce: null });
  w.dataLayer.push({ event, ecommerce: payload });
}

const NAVIGATE_FALLBACK_MS = 300;

/**
 * Full page load to `url`. With `afterEvent`, pushes the event first; when GTM
 * is running, waits for its eventCallback (or 300 ms) and navigates exactly
 * once. Without GTM it navigates at once.
 */
export function hardNavigate(
  url: string,
  opts?: { afterEvent?: { name: string; payload: Record<string, unknown> } },
): void {
  const w = window as DataLayerWindow;
  if (!opts?.afterEvent) {
    w.location.assign(url);
    return;
  }

  const { name, payload } = opts.afterEvent;
  if (!w.google_tag_manager) {
    pushDataLayer(name, payload);
    w.location.assign(url);
    return;
  }

  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    w.location.assign(url);
  };
  const timer = setTimeout(go, NAVIGATE_FALLBACK_MS);

  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push({ ecommerce: null });
  w.dataLayer.push({ event: name, ecommerce: payload, eventCallback: go });
}
