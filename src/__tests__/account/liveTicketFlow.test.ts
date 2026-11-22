import { describe, it, expect } from "vitest";
import {
  canFallBack,
  decide,
  profileStep,
  type BindOutcome,
} from "@/app/(public)/account/tickets/[id]/liveTicketFlow";
import type { StoredToken } from "@/lib/tickets/deviceKey";
import { bindOffset } from "@/lib/tickets/liveClock";

// ─── The ticket page's security branches (review I2, M4) ────────────────────

const KEY = "K".repeat(87);
const OTHER_KEY = "O".repeat(87);
const NOW = { perf: 200, wall: 1_800_000_100 };
const SAVED: StoredToken = { token: "saved.tok.en", jti: "j1", offset: 5, publicKey: KEY };
const OK: BindOutcome = {
  kind: "ok",
  token: "fresh.tok.en",
  jti: "j1",
  serverTime: 1_800_000_000,
  t0: 100,
  t1: 100.4,
  wallAtT1: 1_799_999_990,
};
const status = (s: number): BindOutcome => ({ kind: "status", status: s });

describe("profileStep", () => {
  it("401 → sign in, 2xx → ok, anything else → error", () => {
    expect(profileStep(401)).toBe("signedOut");
    expect(profileStep(200)).toBe("ok");
    for (const s of [400, 403, 404, 429, 500, 503]) expect(profileStep(s)).toBe("error");
  });
});

describe("decide: a fresh bind", () => {
  it("200 → ready, saving { token, jti, publicKey, wall-clock offset }", () => {
    const d = decide(OK, SAVED, KEY, NOW);
    expect(d.kind).toBe("ready");
    if (d.kind !== "ready") return;
    expect(d.notice).toBeNull();
    expect(d.token).toBe("fresh.tok.en");
    const perfOffset = bindOffset(100, 100.4, 1_800_000_000);
    expect(d.perfOffset).toBeCloseTo(perfOffset, 9);
    expect(d.save).toEqual({
      token: "fresh.tok.en",
      jti: "j1",
      publicKey: KEY,
      offset: expect.any(Number),
    });
    // The saved offset is on the wall clock: at t1, wall + offset = perf + perfOffset.
    expect(OK.kind === "ok" && OK.wallAtT1 + d.save!.offset).toBeCloseTo(100.4 + perfOffset, 6);
  });

  it("200 ignores a saved token, even one for another key", () => {
    const d = decide(OK, { ...SAVED, publicKey: OTHER_KEY }, KEY, NOW);
    expect(d).toMatchObject({ kind: "ready", token: "fresh.tok.en", notice: null });
  });
});

describe("decide: refusals never fall back", () => {
  it("401 → sign in, even with a matching saved token", () => {
    expect(decide(status(401), SAVED, KEY, NOW)).toEqual({ kind: "signedOut" });
  });

  it("404 → not available and clear the saved token, even with a matching one", () => {
    expect(decide(status(404), SAVED, KEY, NOW)).toEqual({ kind: "notAvailable", clearSaved: true });
  });

  it.each([400, 403, 409, 413, 422])("%i → error, not a stale QR", (s) => {
    expect(canFallBack(status(s))).toBe(false);
    expect(decide(status(s), SAVED, KEY, NOW)).toEqual({ kind: "error" });
  });

  it("a malformed 200 → error, not a stale QR", () => {
    expect(canFallBack({ kind: "malformed" })).toBe(false);
    expect(decide({ kind: "malformed" }, SAVED, KEY, NOW)).toEqual({ kind: "error" });
  });
});

describe("decide: outages may show the saved ticket", () => {
  const outages: [string, BindOutcome][] = [
    ["429", status(429)],
    ["500", status(500)],
    ["503", status(503)],
    ["network", { kind: "network" }],
  ];

  it.each(outages)("%s with a token saved for THIS key → ready, stale, nothing saved", (_, b) => {
    expect(canFallBack(b)).toBe(true);
    const d = decide(b, SAVED, KEY, NOW);
    expect(d).toMatchObject({ kind: "ready", token: "saved.tok.en", notice: "stale", save: null });
    // Wall-clock offset moved onto the monotonic clock: same server time now.
    if (d.kind === "ready") expect(NOW.perf + d.perfOffset).toBeCloseTo(NOW.wall + SAVED.offset, 6);
  });

  it.each(outages)("%s with a token saved for ANOTHER key → error", (_, b) => {
    expect(decide(b, { ...SAVED, publicKey: OTHER_KEY }, KEY, NOW)).toEqual({ kind: "error" });
  });

  it.each(outages)("%s with nothing saved → error", (_, b) => {
    expect(decide(b, undefined, KEY, NOW)).toEqual({ kind: "error" });
  });
});
