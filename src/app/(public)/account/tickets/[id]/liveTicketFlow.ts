import type { StoredToken } from "@/lib/tickets/deviceKey";
import { bindOffset, rebaseOffset } from "@/lib/tickets/liveClock";

// ─── The ticket page's decisions, pure (static-tested) ──────────────────────
//
// LiveTicket.tsx runs the effects (fetch, IndexedDB, clocks) and hands their
// results here. Every security-relevant branch is in this file:
//   - a saved token is used only if it was bound to THIS browser's key;
//   - 404 clears the saved token and never falls back to it;
//   - 401 means sign in, never a saved QR;
//   - 400 / 403 / other 4xx are errors, never a stale QR: a request the
//     server refused is not an outage.
// Only an outage (429, 5xx, network) may show the saved ticket.

/** What the bind call came back with. t0/t1 are performance.now() seconds; wallAtT1 is Date.now() seconds. */
export type BindOutcome =
  | { kind: "ok"; token: string; jti: string; serverTime: number; t0: number; t1: number; wallAtT1: number }
  | { kind: "status"; status: number }
  | { kind: "malformed" }
  | { kind: "network" };

export type ProfileStep = "signedOut" | "error" | "ok";

/** GET /api/account/profile's status → the next step. */
export function profileStep(status: number): ProfileStep {
  if (status === 401) return "signedOut";
  return status >= 200 && status < 300 ? "ok" : "error";
}

/** Whether a bind failure is an outage, where the saved ticket may stand in. */
export function canFallBack(bind: BindOutcome): boolean {
  if (bind.kind === "network") return true;
  if (bind.kind !== "status") return false;
  return bind.status === 429 || bind.status >= 500;
}

export type Decision =
  | { kind: "signedOut" }
  | { kind: "notAvailable"; clearSaved: true }
  | { kind: "error" }
  | {
      kind: "ready";
      token: string;
      jti: string;
      /** Server time = performance.now()/1000 + perfOffset, for the life of the page. */
      perfOffset: number;
      /** Set after a fresh bind: what to save for the offline fallback. */
      save: StoredToken | null;
      notice: "stale" | null;
    };

/**
 * The page's state after the bind. `saved` is the token stored for this buyer
 * and ticket (read only when canFallBack); `now` is both clocks read together.
 */
export function decide(
  bind: BindOutcome,
  saved: StoredToken | undefined,
  currentPublicKey: string,
  now: { perf: number; wall: number },
): Decision {
  if (bind.kind === "ok") {
    const perfOffset = bindOffset(bind.t0, bind.t1, bind.serverTime);
    return {
      kind: "ready",
      token: bind.token,
      jti: bind.jti,
      perfOffset,
      save: {
        token: bind.token,
        jti: bind.jti,
        offset: rebaseOffset(perfOffset, bind.t1, bind.wallAtT1),
        publicKey: currentPublicKey,
      },
      notice: null,
    };
  }
  if (bind.kind === "status" && bind.status === 401) return { kind: "signedOut" };
  if (bind.kind === "status" && bind.status === 404) return { kind: "notAvailable", clearSaved: true };
  if (canFallBack(bind) && saved && saved.publicKey === currentPublicKey) {
    return {
      kind: "ready",
      token: saved.token,
      jti: saved.jti,
      perfOffset: rebaseOffset(saved.offset, now.wall, now.perf),
      save: null,
      notice: "stale",
    };
  }
  return { kind: "error" };
}
