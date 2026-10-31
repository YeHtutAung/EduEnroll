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

// Class order is digits first on purpose: the ref-shape tests treat the other order as an enrollment ref.
export const GTM_CONTAINER_ID_RE = /^GTM-[0-9A-Z]{4,12}$/;

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
  // Encoded paths fail closed: "/enroll/%66orm" must not read as an event slug.
  if (pathname.includes("%")) return false;
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

function hasSensitiveParam(params: URLSearchParams): boolean {
  const names = new Set(Array.from(params.keys()).map((k) => k.toLowerCase()));
  return SENSITIVE_PARAMS.some((p) => names.has(p));
}

/**
 * True only when nothing sensitive is visible to a third-party script: no
 * sensitive query or hash param (any case), no priority token in the hash,
 * only allowlisted storage keys, no Supabase auth cookie, and no same-origin
 * referrer that is an untracked page or carries a sensitive param (GA4 records
 * page_referrer, and the site's referrer policy sends the full same-origin
 * URL). The document's initial URL must also be a same-origin tracked page
 * with no sensitive param: a document that started anywhere else is not
 * clean, whatever it shows now. Storages are passed as getters because merely
 * reading window.sessionStorage can throw. Any error counts as not clean.
 */
export function isBrowserStateClean(args: {
  location: { search: string; hash: string; origin: string };
  referrer: string;
  sessionStorage: () => KeyedStorage;
  localStorage: () => KeyedStorage;
  cookie: string;
  /** URL of the document's first navigation (see initialDocumentUrl). Missing fails closed. */
  initialUrl: string | undefined;
}): boolean {
  try {
    const query = new URLSearchParams(args.location.search);
    const hash = new URLSearchParams(args.location.hash.replace(/^#/, ""));
    if (hasSensitiveParam(query) || hasSensitiveParam(hash) || hash.has("pa")) return false;

    if (!args.initialUrl) return false;
    const initial = new URL(args.initialUrl);
    if (initial.origin !== args.location.origin) return false;
    if (!isTrackedPath(initial.pathname)) return false;
    if (hasSensitiveParam(initial.searchParams)) return false;
    const initialHash = new URLSearchParams(initial.hash.replace(/^#/, ""));
    if (hasSensitiveParam(initialHash) || initialHash.has("pa")) return false;

    if (args.referrer) {
      const ref = new URL(args.referrer);
      if (ref.origin === args.location.origin) {
        if (!isTrackedPath(ref.pathname)) return false;
        if (hasSensitiveParam(ref.searchParams)) return false;
        if (hasSensitiveParam(new URLSearchParams(ref.hash.replace(/^#/, "")))) return false;
      }
    }

    if (!storageIsClean(args.sessionStorage())) return false;
    if (!storageIsClean(args.localStorage())) return false;

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

/**
 * The URL the current document was first loaded at: the name of its
 * navigation timing entry. Soft navigations do not change it. Undefined when
 * the API is missing, has no entry, or throws.
 */
export function initialDocumentUrl(
  perf: { getEntriesByType(type: string): ArrayLike<{ name: string }> } | undefined,
): string | undefined {
  try {
    const entry = perf?.getEntriesByType("navigation")[0];
    return typeof entry?.name === "string" ? entry.name : undefined;
  } catch {
    return undefined;
  }
}

// ─── Per-document latch ─────────────────────────────────────────────────────
//
// Module state lives as long as the document's JS realm, so it is per document.
// Only the FIRST evaluation in a document may turn GTM on. A document whose
// first evaluation was not clean keeps GTM off until a full page load. Once on,
// later clean evaluations (soft moves between tracked pages) keep it on; any
// evaluation that is not clean turns it off for the rest of the document. A
// container that already started cannot be unloaded; full page loads at every
// exit handle that.

let documentLatch: "unset" | "on" | "off" = "unset";

/** Feeds one evaluation into the latch and returns whether GTM may render now. */
export function decideGtmForDocument(cleanNow: boolean): boolean {
  if (!cleanNow) documentLatch = "off";
  else if (documentLatch === "unset") documentLatch = "on";
  return documentLatch === "on";
}

/** Test-only: start a fresh "document". */
export function resetGtmDocumentLatchForTests(): void {
  documentLatch = "unset";
}

/**
 * pageshow handler: a page restored from the back/forward cache keeps its old
 * JS state, including a running container, so it is reloaded instead and goes
 * through every check again.
 */
export function reloadIfRestoredFromCache(
  event: { persisted?: boolean },
  reload: () => void = () => window.location.reload(),
): void {
  if (event.persisted) reload();
}

/**
 * One navigation per click: returns true for the first caller and false for
 * any later one until the ref is reset, so a double click pushes one event and
 * writes one stash.
 */
export function claimNavigation(ref: { current: boolean }): boolean {
  if (ref.current) return false;
  ref.current = true;
  return true;
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
export function pushDataLayer(
  event: string,
  payload: Record<string, unknown>,
  extra?: { eventCallback?: () => void },
): void {
  const w = window as DataLayerWindow;
  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push({ ecommerce: null });
  w.dataLayer.push({ event, ecommerce: payload, ...extra });
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

  pushDataLayer(name, payload, { eventCallback: go });
}

// ─── GA4 ecommerce payloads ─────────────────────────────────────────────────
//
// Pure builders for the two events the tracked pages push. Payloads carry only
// public event data: ids, names, prices, quantities. No personal data, no ref.

export interface TicketTier {
  id: string;
  name: string;
  price: number;
}

export interface TicketLine extends TicketTier {
  quantity: number;
}

/** `view_item`: one item per ticket tier. */
export function viewItemPayload(args: {
  slug: string;
  eventName: string;
  currency: string;
  tiers: TicketTier[];
}): Record<string, unknown> {
  return {
    event_slug: args.slug,
    event_name: args.eventName,
    currency: args.currency,
    items: args.tiers.map((t) => ({
      item_id: t.id,
      item_name: t.name,
      price: t.price,
    })),
  };
}

/** `begin_checkout`: `value` is the sum of price x quantity over the lines. */
export function beginCheckoutPayload(args: {
  slug: string;
  eventName: string;
  currency: string;
  lines: TicketLine[];
}): Record<string, unknown> {
  return {
    event_slug: args.slug,
    event_name: args.eventName,
    currency: args.currency,
    value: args.lines.reduce((sum, l) => sum + l.price * l.quantity, 0),
    items: args.lines.map((l) => ({
      item_id: l.id,
      item_name: l.name,
      price: l.price,
      quantity: l.quantity,
    })),
  };
}
