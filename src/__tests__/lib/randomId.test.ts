import { describe, it, expect, afterEach, vi } from "vitest";
import { randomId } from "@/lib/randomId";

// ─── randomId works in an insecure context ──────────────────────────────────
//
// `crypto.randomUUID()` is only defined in a secure context — HTTPS or
// localhost. Over plain HTTP it is undefined and calling it throws
// `TypeError: crypto.randomUUID is not a function`, which is exactly what a
// phone hit when opening the enrolment form on a dev server by LAN address.
//
// Production is HTTPS throughout, so this can only ever be caught by testing
// on real hardware — or by these.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const realCrypto = globalThis.crypto;

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true });
  vi.restoreAllMocks();
});

/** Replace the global crypto with one missing the secure-context API. */
function withoutRandomUUID() {
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
    configurable: true,
  });
}

describe("secure context", () => {
  it("uses the native implementation when it exists", () => {
    const spy = vi.spyOn(realCrypto, "randomUUID");
    randomId();
    expect(spy).toHaveBeenCalled();
  });
});

describe("insecure context — the case that broke on a phone", () => {
  it("still returns a valid v4 when randomUUID is missing", () => {
    withoutRandomUUID();
    expect(randomId()).toMatch(UUID_V4);
  });

  it("does not throw", () => {
    withoutRandomUUID();
    expect(() => randomId()).not.toThrow();
  });

  it("still returns a valid v4 when getRandomValues is missing too", () => {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    expect(randomId()).toMatch(UUID_V4);
  });
});

describe("uniqueness", () => {
  // The caller uses this as an idempotency key, so a collision would merge two
  // separate enrolments into one.
  it.each([
    ["secure", () => {}],
    ["insecure", withoutRandomUUID],
  ])("produces distinct values in a %s context", (_label, setup) => {
    setup();
    const ids = new Set(Array.from({ length: 2000 }, () => randomId()));
    expect(ids.size).toBe(2000);
  });
});
