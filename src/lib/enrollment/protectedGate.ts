// ─── The sign-in gate on a protected event's form and checkout ──────────────
//
// Account-bound tickets (design 5.1–5.2): a protected event's order can only
// be placed by a signed-in buyer, and its email is the account's email. The
// server (POST /api/public/enroll) is the control; this is the experience.
//
// Kept free of React so the decisions are testable in vitest's node env.

/**
 * - open:        the event is not protected; the page renders as it always did.
 * - signedOut:   protected, no buyer session → "Sign in to continue".
 * - staff:       protected, a staff session → the staff message.
 * - signedIn:    protected, a buyer session → the form, email read-only.
 * - unavailable: protected, but the session could not be checked → try again.
 */
export type GateState = "open" | "signedOut" | "staff" | "signedIn" | "unavailable";

export interface GateResult {
  state: GateState;
  /** The account email; set only when state is "signedIn". */
  email: string | null;
}

/** GET /api/account/profile's status → the gate. 503 and anything odd fail closed. */
export function gateStateFromStatus(status: number): Exclude<GateState, "open"> {
  if (status === 200) return "signedIn";
  if (status === 401) return "signedOut";
  if (status === 403) return "staff";
  return "unavailable";
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Settles the gate. An unprotected event returns "open" without calling the
 * profile route, so guest checkout costs nothing new.
 */
export async function resolveProtectedGate(
  isProtected: boolean,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<GateResult> {
  if (!isProtected) return { state: "open", email: null };
  try {
    const res = await fetcher("/api/account/profile", { cache: "no-store" });
    const state = gateStateFromStatus(res.status);
    if (state !== "signedIn") return { state, email: null };
    const body = (await res.json().catch(() => null)) as { email?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    if (!email) return { state: "unavailable", email: null };
    return { state: "signedIn", email };
  } catch {
    return { state: "unavailable", email: null };
  }
}

/**
 * The sign-in link: /account with the current path and query as `next`,
 * URL-encoded. /account passes `next` through safeNext() before using it.
 */
export function accountSignInHref(pathname: string, search: string): string {
  const query = search && search !== "?" ? (search.startsWith("?") ? search : `?${search}`) : "";
  return `/account?next=${encodeURIComponent(`${pathname}${query}`)}`;
}

/** The current page's sign-in link, in the browser. */
export function currentSignInHref(): string {
  if (typeof window === "undefined") return "/account";
  return accountSignInHref(window.location.pathname, window.location.search);
}

/** The staff refusal, word for word as POST /api/public/enroll answers it (Task 12). */
export const STAFF_MESSAGE = "Staff accounts can't buy account-bound tickets. Use another email.";

/**
 * Whether the event is protected, as GET /api/public/enroll/[slug] says. When
 * `intakeId` is given, only that intake's flag counts. Unknown (a failed read)
 * is false: these pages then behave as before and the server, which is the
 * control, refuses a protected order without a buyer session (401 / 403).
 */
export async function eventIsProtected(
  slug: string,
  intakeId?: string | null,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<boolean> {
  try {
    const res = await fetcher(`/api/public/enroll/${encodeURIComponent(slug)}`);
    if (!res.ok) return false;
    const json = (await res.json()) as { intake?: { id?: unknown; ticket_protection?: unknown } };
    if (intakeId !== undefined && json.intake?.id !== intakeId) return false;
    return json.intake?.ticket_protection === true;
  } catch {
    return false;
  }
}
