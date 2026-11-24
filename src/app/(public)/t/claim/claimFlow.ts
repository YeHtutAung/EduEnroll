// ─── /t/claim: pure rules for the claim page (plan 4, Task 12) ──────────────
//
// The token stays where STRIP_FRAGMENT_JS put it (sessionStorage, or the
// window.__seatClaim fallback) until the claim answers; finishClaim() then
// removes it from both. It is read only to POST it to
// /api/me/tickets/claim/preview and /api/me/tickets/claim, and is never put in
// React state, rendered, logged or written to the URL.

import { SEAT_CLAIM_KEY, SHARE_TOKEN_PATTERN } from "./stripFragment";

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

/** Forgets the token in both places. Called once the claim answers, or a preview says 404. */
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
  | { kind: "limited"; canRetry: boolean }
  | { kind: "error"; canRetry: boolean };

/** The page's state after a non-200 claim answer (the token is already forgotten). */
export function afterClaim(status: number): ClaimSeatState {
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
