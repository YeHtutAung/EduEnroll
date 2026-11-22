import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync } from "crypto";
import {
  K2_PERIOD_SECONDS,
  K2_SIGN_AHEAD_SECONDS,
  bindOffset,
  qrSlot,
  qrTs,
  rebaseOffset,
  secondsLeftAt,
} from "@/lib/tickets/liveClock";
import { exportPublicKey, k2TextAt } from "@/lib/tickets/deviceKey";
import { verifyK2, K2_PAST_SECONDS, K2_FUTURE_SECONDS } from "@/lib/tickets/k2";
import { signBoundTicket } from "@/lib/tickets/sign";

// ─── liveClock.ts: when each live QR is signed for (review I1, M2) ──────────

const JTI = "11111111-2222-4333-8444-555555555555";
const BASE = 1_800_000_000; // a multiple of 15
/** The scanner's upload delay the page must tolerate. */
const UPLOAD_DELAY = 8;
/** The page ticks once a second, so a QR outlives its slot by up to 1 s. */
const TICK = 1;

let pair: CryptoKeyPair;
let token: string;

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
  pair = (await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  token = signBoundTicket({ jti: JTI, eid: "e1", tier: "GA", admits: 1, exp: BASE + 86_400 }, await exportPublicKey(pair));
});

describe("pure helpers", () => {
  it("bindOffset: anchored to the response's arrival (the route stamps last), +0.5 for the server's floor", () => {
    // Sent at 100, answered at 100.4, server said 1000 (really 1000.0..1000.99).
    expect(bindOffset(100, 100.4, 1000)).toBeCloseTo(1000.5 - 100.4, 9);
  });

  it("rebaseOffset moves an offset between clocks read at the same instant", () => {
    const perfOffset = 900.3; // server = perf + 900.3
    const wall = rebaseOffset(perfOffset, 100.4, 5000.4); // perf 100.4 = wall 5000.4
    expect(100.4 + perfOffset).toBeCloseTo(5000.4 + wall, 9);
    expect(rebaseOffset(wall, 5000.4, 100.4)).toBeCloseTo(perfOffset, 9);
  });

  it("qrTs is the slot start plus the sign-ahead, for every instant of the slot", () => {
    for (let t = BASE; t < BASE + K2_PERIOD_SECONDS; t += 0.25) {
      expect(qrTs(qrSlot(t))).toBe(BASE + K2_SIGN_AHEAD_SECONDS);
    }
    expect(qrTs(qrSlot(BASE + K2_PERIOD_SECONDS))).toBe(BASE + K2_PERIOD_SECONDS + K2_SIGN_AHEAD_SECONDS);
  });

  it("secondsLeftAt counts down 15..1", () => {
    expect(secondsLeftAt(BASE)).toBe(15);
    expect(secondsLeftAt(BASE + 14.9)).toBe(1);
  });

  it("the budget: newest QR inside +10 s, oldest plus upload delay inside −20 s", () => {
    expect(K2_SIGN_AHEAD_SECONDS).toBeLessThanOrEqual(K2_FUTURE_SECONDS);
    const oldest = K2_SIGN_AHEAD_SECONDS - (K2_PERIOD_SECONDS + TICK); // −11
    expect(oldest).toBe(-11);
    expect(oldest - UPLOAD_DELAY).toBeGreaterThan(-K2_PAST_SECONDS);
  });
});

/**
 * Simulates the page: a bind round trip on the monotonic clock (t0..t1), the
 * server stamping its floored time somewhere inside it, then QRs drawn per
 * slot and scanned at every point they are on screen, plus an upload delay.
 */
async function sweep(opts: { trueOffset: number; t0: number; t1: number; stampAt: number }) {
  const { trueOffset, t0, t1, stampAt } = opts;
  const serverTime = Math.floor(stampAt + trueOffset);
  const perfOffset = bindOffset(t0, t1, serverTime);
  const err = trueOffset - perfOffset; // true server time = estimate + err
  const failures: string[] = [];
  const firstSlot = qrSlot(t1 + perfOffset) + 1;
  for (let slot = firstSlot; slot < firstSlot + 2; slot++) {
    const qr = await k2TextAt(pair, { token, jti: JTI }, qrTs(slot));
    const shownFrom = slot * K2_PERIOD_SECONDS; // estimated server time
    const shownTo = (slot + 1) * K2_PERIOD_SECONDS + TICK;
    for (let est = shownFrom; est <= shownTo; est += 0.5) {
      for (const upload of [0, UPLOAD_DELAY]) {
        const scannerNow = est + err + upload;
        if (!verifyK2(qr, scannerNow)) failures.push(`slot ${slot} est ${est} upload ${upload}`);
      }
    }
  }
  return { failures, err };
}

describe("every QR verifies for its whole time on screen plus an 8 s upload", () => {
  for (const frac of [0.01, 0.5, 0.99]) {
    // The route stamps last, so "t0" is the worst case (a 0.4 s return trip), not a real one.
    for (const where of ["t0", "mid", "t1"] as const) {
      it(`server clock fraction ${frac}, stamped at ${where} of a 0.4 s round trip`, async () => {
        const t0 = 100;
        const t1 = 100.4;
        const stampAt = where === "t0" ? t0 : where === "t1" ? t1 : (t0 + t1) / 2;
        const { failures } = await sweep({ trueOffset: BASE - 100 + frac, t0, t1, stampAt });
        expect(failures).toEqual([]);
      });
    }
  }

  it("a slow server (24 s, e.g. an email send) doesn't push the clock ahead: the stamp is taken last", async () => {
    // Codex P2 on #495: the midpoint assumption put the phone ~12 s ahead here,
    // past the +10 s limit for part of every slot.
    const t0 = 100;
    const t1 = 124.4; // 24 s of server work, then 0.4 s back over the network
    const stampAt = 124.0;
    const { failures, err } = await sweep({ trueOffset: BASE - 100 + 0.5, t0, t1, stampAt });
    expect(failures).toEqual([]);
    expect(err).toBeGreaterThanOrEqual(0); // the estimate is behind (older QR), never ahead
    expect(err).toBeLessThanOrEqual(1.5);
    // The old midpoint estimate: ~12 s ahead.
    const serverTime = Math.floor(stampAt + BASE - 100 + 0.5);
    const midpoint = serverTime + 0.5 - (t0 + t1) / 2;
    expect(BASE - 100 + 0.5 - midpoint).toBeLessThan(-10);
  });

  it("a list call 2.5 s slower than the bind doesn't move the offset (t0/t1 bracket the bind alone)", async () => {
    // Bind 100 → 100.4; the list (in parallel) lands at 102.9. Only the bind's
    // own timestamps reach bindOffset, so the error stays within ±0.7 s.
    const t0 = 100;
    const t1 = 100.4;
    const listDone = 102.9;
    const { failures, err } = await sweep({ trueOffset: BASE - 100 + 0.5, t0, t1, stampAt: 100.2 });
    expect(Math.abs(err)).toBeLessThanOrEqual(0.7);
    expect(failures).toEqual([]);
    // What the old code did: offset taken when everything had settled.
    const serverTime = Math.floor(100.2 + BASE - 100 + 0.5);
    const late = serverTime - listDone;
    expect(Math.abs(BASE - 100 + 0.5 - late)).toBeGreaterThan(2);
  });
});
