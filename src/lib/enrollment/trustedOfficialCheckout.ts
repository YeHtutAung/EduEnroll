import { randomId } from "@/lib/randomId";

// Creates a Trusted Official order from the cart stash left by /tickets.
//
// /tickets is a tracked page (Google Tag Manager may run there), so it must never
// receive an enrollment ref or an idempotency key: `submit_cart_enrollment` hands
// back the existing order, ref included, for a known key. The POST therefore
// happens here, on /checkout/new, which is untracked.
// Design: docs/superpowers/specs/2026-10-30-tenant-gtm-design.md

export interface CartStash {
  slug: string;
  items: { class_id: string; quantity: number }[];
  terms_accepted: true;
  terms_version: string;
  organiser_terms_sha256: string | null;
}

export type CheckoutNewResult =
  | { kind: "redirect-tickets" }
  | { kind: "created"; ref: string }
  | { kind: "error"; message: string };

/** Storage key of the stash. Only digits are accepted, matching the GTM storage allowlist. */
export function cartStashKey(cartKey: string): string {
  return `cart_${cartKey}`;
}

/** Storage key of the idempotency key. Not on the GTM allowlist: while it exists, GTM stays off. */
export function idempotencyStorageKey(cartKey: string): string {
  return `ck_${cartKey}`;
}

/** Parses and validates a stash. Returns null for anything unusable or for another event. */
export function parseCartStash(raw: string | null, slug: string): CartStash | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (s.slug !== slug) return null;
  if (!Array.isArray(s.items) || s.items.length === 0) return null;
  const items: CartStash["items"] = [];
  for (const it of s.items) {
    if (!it || typeof it !== "object") return null;
    const { class_id, quantity } = it as Record<string, unknown>;
    if (typeof class_id !== "string" || class_id === "") return null;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) return null;
    items.push({ class_id, quantity });
  }
  if (s.terms_accepted !== true) return null;
  if (typeof s.terms_version !== "string" || s.terms_version === "") return null;
  const sha = s.organiser_terms_sha256;
  if (sha !== null && typeof sha !== "string") return null;
  return {
    slug,
    items,
    terms_accepted: true,
    terms_version: s.terms_version,
    organiser_terms_sha256: sha,
  };
}

/**
 * The current document's navigation type ("navigate", "reload",
 * "back_forward", "prerender"). Undefined when the API is missing, has no
 * entry, or throws.
 */
export function currentNavigationType(
  perf: { getEntriesByType(type: string): ArrayLike<object> } | undefined,
): string | undefined {
  try {
    const entry = perf?.getEntriesByType("navigation")[0] as { type?: unknown } | undefined;
    const t = entry?.type;
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

function readItem(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * One order attempt, prepared once per document: the stash body plus the
 * idempotency key minted (or, on a reload, reused) for it. The page keeps it
 * in memory so "Try again" re-sends exactly this body and key.
 */
export interface OrderAttempt {
  slug: string;
  cartKey: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
}

export type PrepareResult =
  | { kind: "redirect-tickets" }
  | { kind: "error"; message: string }
  | { kind: "ready"; attempt: OrderAttempt };

/**
 * Reads and validates the stash and settles the idempotency key. Does not POST.
 * Reads sessionStorage from the environment, so tests can stub the global.
 */
export function prepareTrustedOfficialOrder(args: {
  slug: string;
  cartKey: string | null;
  /** See currentNavigationType. Only "reload" may reuse a stored key. */
  navigationType: string | undefined;
}): PrepareResult {
  const { slug, cartKey } = args;
  if (!cartKey || !/^\d+$/.test(cartKey)) return { kind: "redirect-tickets" };

  const stash = parseCartStash(readItem(cartStashKey(cartKey)), slug);
  if (!stash) return { kind: "redirect-tickets" };

  // The key lives only in ck_<cart_key>, never in the stash. It is written BEFORE
  // the POST so a reload mid-request re-sends the same key and gets the same order.
  // A stored key is reused only on a reload of this same page; any other arrival
  // (including an unknown navigation type) mints a fresh key and overwrites it.
  const ckKey = idempotencyStorageKey(cartKey);
  let idempotencyKey = args.navigationType === "reload" ? readItem(ckKey) : null;
  if (!idempotencyKey) {
    idempotencyKey = randomId();
    try {
      sessionStorage.setItem(ckKey, idempotencyKey);
    } catch {
      return { kind: "error", message: "Your browser blocked storage. Please enable it and try again." };
    }
  }

  // Priority token from the URL fragment capture (see priorityUnlock.ts), sent
  // only in this POST body.
  const priorityToken = readItem(`pa_${slug}`);

  return {
    kind: "ready",
    attempt: {
      slug,
      cartKey,
      idempotencyKey,
      body: {
        items: stash.items,
        terms_accepted: stash.terms_accepted,
        terms_version: stash.terms_version,
        organiser_terms_sha256: stash.organiser_terms_sha256,
        idempotency_key: idempotencyKey,
        ...(priorityToken ? { priority_token: priorityToken } : {}),
      },
    },
  };
}

/**
 * POSTs a prepared attempt. Safe to call again with the same attempt after an
 * error: the same key makes the server return the same order rather than a
 * second one. On success the stash and ck_ are removed; on any error they stay.
 */
export async function submitTrustedOfficialOrder(attempt: OrderAttempt): Promise<CheckoutNewResult> {
  try {
    const res = await fetch("/api/public/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt.body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message ?? "Enrollment failed.");
    if (!data.enrollment_ref) throw new Error("Enrollment failed.");
    // ck_ stays on every error path: the order may exist with a lost response.
    try {
      sessionStorage.removeItem(cartStashKey(attempt.cartKey));
      sessionStorage.removeItem(idempotencyStorageKey(attempt.cartKey));
    } catch {
      // Nothing more to do; the redirect proceeds.
    }
    return { kind: "created", ref: String(data.enrollment_ref) };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Something went wrong. Please try again.",
    };
  }
}

/** Prepare and submit in one step: the first attempt in a document. */
export async function createTrustedOfficialOrder(args: {
  slug: string;
  cartKey: string | null;
  navigationType: string | undefined;
}): Promise<CheckoutNewResult> {
  const prepared = prepareTrustedOfficialOrder(args);
  if (prepared.kind !== "ready") return prepared;
  return submitTrustedOfficialOrder(prepared.attempt);
}
