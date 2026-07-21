import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── The HitPay wrapper must not carry the provider body in its error ───────
//
// This is the root of the leak the route-level tests observe. The wrapper used
// to build its Error as `... failed (422): ${await res.text()}`, so the raw
// response body travelled inside the message and reached every log line and
// error response that touched it. A caller cannot sanitize what it is handed —
// truncation only shortens the leak — so the body must never be attached.

const originalFetch = global.fetch;

beforeEach(() => {
  vi.resetModules();
  process.env.HITPAY_API_KEY = "test_only";
  process.env.HITPAY_SALT = "test_salt_only";
  process.env.HITPAY_MODE = "sandbox";
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("hitpay.createPaymentRequest — error carries no provider body", () => {
  it("omits the response body and exposes the HTTP status as a field", async () => {
    const BODY = '{"errors":{"amount":"internal-token-abc123"},"customer":"a@b.test"}';
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => BODY,
      json: async () => JSON.parse(BODY),
    })) as unknown as typeof fetch;

    const { default: hitpay } = await import("@/lib/hitpay");

    const err = await hitpay
      .createPaymentRequest({
        amount: "100.00",
        currency: "SGD",
        method: "paynow_online",
        referenceNumber: "F-0001",
      })
      .then(
        () => null,
        (e: unknown) => e as Error & { status?: number },
      );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("internal-token-abc123");
    expect(err!.message).not.toContain("a@b.test");
    expect(err!.message).not.toContain(BODY);
    // The status survives as a structured field, so callers get a safe
    // diagnostic without parsing the message.
    expect(err!.status).toBe(422);
    expect(err!.message).toContain("HTTP 422");
  });
});
