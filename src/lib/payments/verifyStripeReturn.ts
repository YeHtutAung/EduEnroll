// Client-side verification of a hosted-Checkout return (Plan v18 §3c client
// behaviour, PR #205 review).
//
// /stripe/verify now returns 500 for RETRYABLE settlement states (fulfilment
// failure, transient database failure) — deliberately, because the webhook
// and the next verify call both retry. The client therefore must never treat
// a non-OK response as "keep spinning forever": TRANSIENT failures (5xx,
// network) retry with bounded backoff, PERMANENT ones (4xx) surface support
// after a single attempt, and exhaustion degrades to a NEUTRAL "confirmation
// still processing" state — never "payment received": a network failure or a
// persistent "pending" is not proof any payment landed.

export type VerifyOutcome =
  | { kind: "status"; status: string } // enrollment status (confirmed, …)
  | { kind: "conflict" } // terminal — support state, stop retrying
  | { kind: "permanent_error" } // 4xx: will not self-heal — support, ONE attempt
  | { kind: "pending_confirmation" }; // transient retries exhausted / still pending

const DEFAULT_MAX_ATTEMPTS = 5;
const defaultDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 8000);

export async function verifyStripeReturn(opts: {
  sessionId: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  delayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<VerifyOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = opts.delayMs ?? defaultDelay;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(delayMs(attempt - 1));
    try {
      const res = await fetchImpl(
        `/api/public/payments/stripe/verify?session_id=${encodeURIComponent(opts.sessionId)}`,
      );
      if (!res.ok) {
        // Only TRANSIENT failures retry (5xx: the route's deliberate
        // retryable-settlement signal). A 4xx is permanent: the creation
        // contract finalizes the payment row BEFORE returning the Checkout
        // URL, so a paid Session with no row (404) is an orphan/anomaly that
        // no amount of retrying self-heals — surface support after ONE
        // attempt instead of five wasted ones ending in false reassurance.
        if (res.status >= 500) continue;
        return { kind: "permanent_error" };
      }
      const data = (await res.json()) as { status?: string };
      if (data.status === "settlement_conflict") return { kind: "conflict" };
      // "pending": Stripe has not marked the session paid yet — the webhook
      // may land any moment; retry rather than leaving a spinner forever.
      if (!data.status || data.status === "pending") continue;
      return { kind: "status", status: data.status };
    } catch {
      // Network failure — same bounded retry, never a silent infinite spinner.
      continue;
    }
  }
  return { kind: "pending_confirmation" };
}
