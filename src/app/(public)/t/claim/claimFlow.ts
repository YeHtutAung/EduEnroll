// ─── /t/claim: pure rules for the claim page (plan 4, Task 12) ──────────────
//
// The token stays where STRIP_FRAGMENT_JS put it (sessionStorage, or the
// window.__seatClaim fallback) until the claim answers; finishClaim() then
// removes it from both. It is read only to POST it to
// /api/me/tickets/claim/preview and /api/me/tickets/claim, and is never put in
// React state, rendered, logged or written to the URL.

import { SEAT_CLAIM_KEY, SHARE_TOKEN_PATTERN, stripFragment } from "./stripFragment";

const TOKEN_RE = new RegExp(SHARE_TOKEN_PATTERN);

interface ClaimWindow {
  sessionStorage: Pick<Storage, "getItem" | "removeItem">;
  __seatClaim?: string;
}

function currentWindow(): ClaimWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as ClaimWindow);
}

const isClaimToken = (v: unknown): v is string => typeof v === "string" && TOKEN_RE.test(v);

/** The stored token, or null. sessionStorage first, then the fallback. */
export function readClaimToken(win: ClaimWindow | null = currentWindow()): string | null {
  if (!win) return null;
  let stored: string | null = null;
  try {
    stored = win.sessionStorage.getItem(SEAT_CLAIM_KEY);
  } catch {
    stored = null;
  }
  if (isClaimToken(stored)) return stored;
  return isClaimToken(win.__seatClaim) ? win.__seatClaim : null;
}

interface MountWindow extends ClaimWindow {
  location: { hash: string };
  history: { replaceState: (data: unknown, unused: string, url: string) => void };
  sessionStorage: Pick<Storage, "getItem" | "removeItem" | "setItem">;
}

/**
 * On mount: if the fragment is still in the URL (the inline script didn't
 * run), strip and store it first; then read the token.
 */
export function takeClaimToken(win: MountWindow | null = currentWindow() as MountWindow | null): string | null {
  if (!win) return null;
  let hash = "";
  try {
    hash = win.location.hash || "";
  } catch {
    hash = "";
  }
  if (hash) stripFragment(win);
  return readClaimToken(win);
}

/** Forgets the token in both places. Called once the claim answers (except 401), or a preview says 404. */
export function finishClaim(win: ClaimWindow | null = currentWindow()): void {
  if (!win) return;
  try {
    win.sessionStorage.removeItem(SEAT_CLAIM_KEY);
  } catch {
    // Blocked storage: the token can only be on the fallback.
  }
  try {
    delete win.__seatClaim;
  } catch {
    win.__seatClaim = undefined;
  }
}

export type PreviewDecision = "ready" | "signIn" | "gone" | "limited" | "error";

/** What the preview's status means for the page. Every link refusal is the one 404. */
export function decide(status: number): PreviewDecision {
  switch (status) {
    case 200:
      return "ready";
    case 401:
      return "signIn";
    case 404:
      return "gone";
    case 429:
      return "limited";
    default:
      return "error";
  }
}

export interface ClaimPreview {
  eventName: string;
  tier: string;
  seatNo: number;
  eventDate: string | null;
}

/**
 * `canRetry` is true only while the token is still stored: after the claim has
 * answered it is gone, and the friend has to open the link again.
 */
export type ClaimSeatState =
  | { kind: "loading" }
  | { kind: "ready"; preview: ClaimPreview; claiming: boolean }
  | { kind: "signIn" }
  | { kind: "gone" }
  /** No token could be read: the link wasn't opened here, or it was opened in another tab. */
  | { kind: "noToken" }
  | { kind: "limited"; canRetry: boolean }
  | { kind: "error"; canRetry: boolean };

/**
 * The page's state after a non-200 claim answer. The token is already
 * forgotten, except on 401: it stays stored across the sign-in, and the
 * preview runs again when /account sends the friend back.
 */
export function afterClaim(status: number): ClaimSeatState {
  if (status === 401) return { kind: "signIn" };
  if (status === 404) return { kind: "gone" };
  if (status === 429) return { kind: "limited", canRetry: false };
  return { kind: "error", canRetry: false };
}

/** The preview route's 200 body; anything malformed is null. */
export function readPreview(body: unknown): ClaimPreview | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.eventName !== "string" || typeof b.tier !== "string" || typeof b.seatNo !== "number") return null;
  return {
    eventName: b.eventName,
    tier: b.tier,
    seatNo: b.seatNo,
    eventDate: typeof b.eventDate === "string" ? b.eventDate : null,
  };
}

/** The claim route's 200 body: `{ ticketId }`, or null. */
export function readTicketId(body: unknown): string | null {
  const id = typeof body === "object" && body !== null ? (body as { ticketId?: unknown }).ticketId : undefined;
  return typeof id === "string" && id !== "" ? id : null;
}

export const ticketHref = (ticketId: string) => `/account/tickets/${encodeURIComponent(ticketId)}`;

export type ClaimResult = { redirect: string } | { state: ClaimSeatState };

/**
 * POSTs the claim and decides what happens to the token. No answer, or 401,
 * keeps it (a retry or the sign-in round trip needs it); every other answer
 * forgets it.
 */
export async function submitClaim(
  token: string,
  post: (url: string, token: string) => Promise<Response>,
  win: ClaimWindow | null = currentWindow(),
): Promise<ClaimResult> {
  let res: Response;
  try {
    res = await post("/api/me/tickets/claim", token);
  } catch {
    return { state: { kind: "error", canRetry: true } };
  }
  if (res.status === 401) return { state: afterClaim(401) };
  finishClaim(win);
  if (res.ok) {
    const ticketId = readTicketId(await res.json().catch(() => null));
    return ticketId ? { redirect: ticketHref(ticketId) } : { state: { kind: "error", canRetry: false } };
  }
  return { state: afterClaim(res.status) };
}
