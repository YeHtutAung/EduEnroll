// Priority-window UI unlock.
//
// The gate that decides whether a token really buys early access lives in the
// database: priority_access_granted(), consulted inside submit_enrollment and
// submit_cart_enrollment in the same transaction as the seat decrement. That is
// the authority, and nothing in this file second-guesses it.
//
// What this file decides is narrower and purely presentational — whether the
// browser lets a visitor REACH the enrollment form at all.
//
// ── The bug this exists to close ────────────────────────────────────────────
//
// A tier with a future enrollment_open_at rendered disabled for everyone,
// because card state was computed from enrollment_open_at alone. So an invitee
// holding a valid token, during an open priority window, saw the tier greyed
// out under "OPENS <date>" and clicking it did nothing. The token was read only
// at the enrollment form (see the form page), and the card was the only route
// to that form. Measured on staging against a real signup: the server gate
// returned true for that exact token and class while the UI refused to open the
// door. Every server-side piece of the feature worked and none of it was
// reachable.
//
// ── Why the unlock is optimistic ────────────────────────────────────────────
//
// The client cannot validate a token. Only hashes are stored, and the gate
// function is revoked from every client role, so there is nothing for the
// browser to ask. Holding any token for this slug while the window is open is
// therefore enough to raise the shutter.
//
// That is deliberate, not a gap. A token that is forged, revoked, expired, or
// for a different event still fails at submit, where the refusal is
// authoritative, transactional, and cheap. The cost of being wrong here is one
// clear error a step later; the cost of being conservative here was a feature
// nobody could use. This is a shutter, not a lock.
//
// Note the asymmetry with the signup CTA: signup closes the instant the window
// opens (a late signup would mint itself a head start), whereas redemption only
// BEGINS at that instant. The two conditions are near-opposites, which is why
// this file does not share a helper with the CTA's own check.

import type { TemplateClass } from "@/components/enrollment/templates/types";

/** sessionStorage key holding the raw token for one event slug. */
function storageKey(slug: string): string {
  return `pa_${slug}`;
}

/**
 * Read the stashed token, if any.
 *
 * Every access is guarded: sessionStorage throws outright in some privacy
 * modes, and a visitor with storage disabled must still get a working — merely
 * un-unlocked — event page rather than a blank one.
 */
export function readPriorityToken(slug: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(slug));
  } catch {
    return null;
  }
}

/**
 * Capture `#pa=<token>` from the address bar into sessionStorage, strip it from
 * the URL, and return the token now in force (freshly captured or previously
 * stashed).
 *
 * A fragment is never sent to the server, which is the whole reason the emailed
 * link uses `#pa=` and not `?pa=`. Stripping it immediately keeps the
 * credential out of browser history and out of anything the visitor might paste
 * or screenshot; sessionStorage then carries it across the navigation to the
 * form.
 *
 * Safe to call on any page: with no fragment present it degrades to a read.
 */
export function capturePriorityToken(slug: string): string | null {
  if (typeof window === "undefined") return null;

  const match = /(?:^|[#&])pa=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (match) {
    try {
      sessionStorage.setItem(storageKey(slug), match[1]);
    } catch {
      // Storage refused. The token is still live for this render via the return
      // below, so the visitor can complete a purchase in this tab; it simply
      // will not survive a reload. Better than throwing away the page.
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return match[1];
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return match[1];
  }

  return readPriorityToken(slug);
}

/**
 * Whether this visitor may bypass a covered tier's "not open yet" shutter.
 *
 * Both halves are required. A token with a window that has not opened yet must
 * not unlock anything — that is the head start being taken early, and the
 * server would refuse it anyway. An open window without a token is simply the
 * public still waiting for the public sale date.
 */
export function isPriorityUnlocked(
  priorityOpenAt: string | null | undefined,
  token: string | null,
  now: number = Date.now(),
): boolean {
  if (!token) return false;
  if (!priorityOpenAt) return false;
  const opensAt = Date.parse(priorityOpenAt);
  if (Number.isNaN(opensAt)) return false;
  return opensAt <= now;
}

/**
 * Stamp `priority_unlocked` onto the tiers the window covers.
 *
 * Only tiers in `coveredClassIds` are stamped — those still behind a future
 * enrollment_open_at. A tier already on public sale needs no token and is left
 * alone, so the flag never appears where it could not matter.
 *
 * Returns the same array identity when nothing is unlocked, so the common path
 * (no token, or window not yet open) allocates nothing.
 */
export function applyPriorityUnlock<T extends Pick<TemplateClass, "id">>(
  classes: T[],
  opts: {
    priorityOpenAt: string | null | undefined;
    coveredClassIds: string[];
    token: string | null;
    now?: number;
  },
): T[] {
  if (!isPriorityUnlocked(opts.priorityOpenAt, opts.token, opts.now)) return classes;
  if (opts.coveredClassIds.length === 0) return classes;

  const covered = new Set(opts.coveredClassIds);
  return classes.map((c) => (covered.has(c.id) ? { ...c, priority_unlocked: true } : c));
}
