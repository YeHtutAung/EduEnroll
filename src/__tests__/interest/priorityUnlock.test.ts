import { describe, it, expect } from "vitest";
import { isPriorityUnlocked, applyPriorityUnlock } from "@/lib/interest/priorityUnlock";
import { getCardState } from "@/components/enrollment/templates/types";
import type { TemplateClass } from "@/components/enrollment/templates/types";

// ─── Priority-window UI unlock ──────────────────────────────────────────────
//
// The regression these cover: a tier with a future enrollment_open_at was
// disabled for everyone, so an invitee holding a valid token during an open
// window saw "OPENS <date>" and clicking did nothing — while the database gate
// would have admitted them. The whole redemption half of the feature was
// unreachable through the UI.
//
// Fixed times wherever the code under test accepts an injected `now` — a test
// that asks whether "now" is inside a window is a test that can fail at 23:59,
// and the thing under test is a comparison, not a clock. getCardState takes no
// `now`, so its block below uses real-clock-relative fixtures instead; the
// comment there says why.

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-01T12:00:00Z");
const PAST = new Date(NOW - HOUR).toISOString();
const FUTURE = new Date(NOW + HOUR).toISOString();

const TOKEN = "77EbRMp3eVMdN0Kr_4H1yBW";

function tier(over: Partial<TemplateClass> = {}): TemplateClass {
  return {
    id: "class-1",
    level: "Tier A",
    fee_amount: 1000,
    fee_formatted: "1,000 MMK",
    seat_remaining: 10,
    seat_total: 30,
    enrollment_open_at: null,
    enrollment_close_at: null,
    status: "open",
    ...over,
  };
}

describe("isPriorityUnlocked", () => {
  it("unlocks when the window has opened and a token is held", () => {
    expect(isPriorityUnlocked(PAST, TOKEN, NOW)).toBe(true);
  });

  it("stays locked before the window opens — that is the head start taken early", () => {
    expect(isPriorityUnlocked(FUTURE, TOKEN, NOW)).toBe(false);
  });

  it("stays locked without a token — the public is simply still waiting", () => {
    expect(isPriorityUnlocked(PAST, null, NOW)).toBe(false);
  });

  it("stays locked when no window is scheduled at all", () => {
    expect(isPriorityUnlocked(null, TOKEN, NOW)).toBe(false);
    expect(isPriorityUnlocked(undefined, TOKEN, NOW)).toBe(false);
  });

  it("stays locked on an unparseable timestamp rather than defaulting open", () => {
    expect(isPriorityUnlocked("not a date", TOKEN, NOW)).toBe(false);
  });
});

describe("applyPriorityUnlock", () => {
  const covered = tier({ id: "covered", enrollment_open_at: FUTURE });
  const onSale = tier({ id: "on-sale", enrollment_open_at: PAST });

  it("stamps only the tiers the window covers", () => {
    const out = applyPriorityUnlock([covered, onSale], {
      priorityOpenAt: PAST,
      coveredClassIds: ["covered"],
      token: TOKEN,
      now: NOW,
    });

    expect(out.find((c) => c.id === "covered")?.priority_unlocked).toBe(true);
    // A tier already on public sale needs no token, so the flag never appears
    // where it could not matter.
    expect(out.find((c) => c.id === "on-sale")?.priority_unlocked).toBeUndefined();
  });

  it("returns the input untouched when the window has not opened", () => {
    const input = [covered];
    const out = applyPriorityUnlock(input, {
      priorityOpenAt: FUTURE,
      coveredClassIds: ["covered"],
      token: TOKEN,
      now: NOW,
    });
    expect(out).toBe(input);
  });

  it("returns the input untouched without a token", () => {
    const input = [covered];
    expect(
      applyPriorityUnlock(input, {
        priorityOpenAt: PAST,
        coveredClassIds: ["covered"],
        token: null,
        now: NOW,
      }),
    ).toBe(input);
  });

  it("does not mutate the classes it is given", () => {
    const input = [tier({ id: "covered", enrollment_open_at: FUTURE })];
    applyPriorityUnlock(input, {
      priorityOpenAt: PAST,
      coveredClassIds: ["covered"],
      token: TOKEN,
      now: NOW,
    });
    expect(input[0].priority_unlocked).toBeUndefined();
  });
});

// getCardState takes no `now` — it reads the real clock, because every caller
// is a component rendering at the present instant. So these fixtures are
// relative to the real clock rather than the fixed NOW above, with an hour of
// margin either side for the same reason priority-window.db.test.ts keeps its
// margins: a sub-second boundary would not discriminate a `<` vs `<=` slip, it
// would only add flake.
const REAL_FUTURE = new Date(Date.now() + HOUR).toISOString();
const REAL_PAST = new Date(Date.now() - HOUR).toISOString();

describe("getCardState honours priority_unlocked", () => {
  it("locks a future tier for an ordinary visitor", () => {
    const state = getCardState(tier({ enrollment_open_at: REAL_FUTURE }));
    expect(state.notYetOpen).toBe(true);
    expect(state.isDisabled).toBe(true);
    expect(state.overlayState).toBe("not_open");
  });

  it("opens that same tier for a token holder — the bug this fixes", () => {
    const state = getCardState(tier({ enrollment_open_at: REAL_FUTURE, priority_unlocked: true }));
    expect(state.notYetOpen).toBe(false);
    expect(state.isDisabled).toBe(false);
    expect(state.overlayState).toBeNull();
  });

  // The bypass is scoped to exactly one of the three conditions. A head start
  // is permission to buy EARLY, not permission to buy what is gone or expired —
  // and letting it widen is how a UI convenience turns into an oversell.
  it("still refuses a sold-out tier", () => {
    const state = getCardState(
      tier({ enrollment_open_at: REAL_FUTURE, priority_unlocked: true, seat_remaining: 0 }),
    );
    expect(state.isDisabled).toBe(true);
    expect(state.overlayState).toBe("full");
  });

  it("still refuses a tier marked full with seats on the clock", () => {
    const state = getCardState(
      tier({ enrollment_open_at: REAL_FUTURE, priority_unlocked: true, status: "full" }),
    );
    expect(state.isDisabled).toBe(true);
  });

  it("still refuses a tier whose sale has already closed", () => {
    const state = getCardState(
      tier({ enrollment_open_at: REAL_FUTURE, priority_unlocked: true, enrollment_close_at: REAL_PAST }),
    );
    expect(state.isDisabled).toBe(true);
    expect(state.overlayState).toBe("closed");
  });
});
