// Browser-safe, no imports. The time maths of the live k2 QR (design 6.2).
//
// The page keeps server time as `clockSeconds + offset`, where clockSeconds is
// a monotonic clock (performance.now() / 1000) while the page is open, so a
// phone clock correction mid-session doesn't move the QR.

/** A new QR every 15 s, on boundaries of server time. */
export const K2_PERIOD_SECONDS = 15;

/**
 * Each QR is signed for 5 s past the start of its slot. A QR is shown for up
 * to ~16 s (its slot plus the 1 s tick), so at the scanner ts − now runs from
 * +5 down to −11. That leaves ~9 s for the scanner's upload delay before the
 * −20 s limit (K2_PAST_SECONDS), and never exceeds the +10 s limit
 * (K2_FUTURE_SECONDS).
 */
export const K2_SIGN_AHEAD_SECONDS = 5;

/**
 * Server time minus the local clock, from one bind round trip.
 * t0 = local clock just before the request, t1 = when the response arrived
 * (seconds, any one clock). The bind route stamps `serverTime` (floored
 * seconds) as its LAST step, after its database calls and, on a phone change,
 * the new-phone email. So the stamp sits near t1, not at the midpoint: a slow
 * server would otherwise push the estimate ahead by half its processing time
 * (and past the +10 s limit). Anchor to t1 and add 0.5 to undo the floor. The
 * only error left is the response's network time, which makes the QR slightly
 * older, and the −20 s side has the room for it. t0 is kept for callers and
 * as a sanity bound.
 */
export function bindOffset(t0: number, t1: number, serverTime: number): number {
  void t0;
  return serverTime + 0.5 - t1;
}

/** Moves an offset from one local clock to another, read at the same instant. */
export function rebaseOffset(offset: number, fromNow: number, toNow: number): number {
  return fromNow + offset - toNow;
}

/** The 15-s slot server time is in. */
export function qrSlot(serverNowSeconds: number): number {
  return Math.floor(serverNowSeconds / K2_PERIOD_SECONDS);
}

/** The `ts` signed into every QR of a slot. */
export function qrTs(slot: number): number {
  return slot * K2_PERIOD_SECONDS + K2_SIGN_AHEAD_SECONDS;
}

/** Seconds until the next slot, 1..15, for the countdown. */
export function secondsLeftAt(serverNowSeconds: number): number {
  return K2_PERIOD_SECONDS - (Math.floor(serverNowSeconds) % K2_PERIOD_SECONDS);
}
