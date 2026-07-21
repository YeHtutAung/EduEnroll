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

const BODY = '{"errors":{"amount":"internal-token-abc123"},"customer":"a@b.test"}';

/** A failing response whose body records whether it was cancelled. */
function failingResponse(cancel: () => Promise<void>) {
  return {
    ok: false,
    status: 422,
    body: { cancel },
    text: async () => BODY,
    json: async () => JSON.parse(BODY),
  };
}

const createRequest = async () => {
  const { default: hitpay } = await import("@/lib/hitpay");
  return hitpay
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
};

describe("hitpay.createPaymentRequest — error carries no provider body", () => {
  it("omits the response body and exposes the HTTP status as a field", async () => {
    global.fetch = vi.fn(async () =>
      failingResponse(async () => {}),
    ) as unknown as typeof fetch;

    const err = await createRequest();

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("internal-token-abc123");
    expect(err!.message).not.toContain("a@b.test");
    expect(err!.message).not.toContain(BODY);
    // The status survives as a structured field, so callers get a safe
    // diagnostic without parsing the message.
    expect(err!.status).toBe(422);
    expect(err!.message).toContain("HTTP 422");
  });

  it("discards the unread body so the connection is not abandoned", async () => {
    // Not cosmetic: undici keeps the connection open for an unconsumed body,
    // and a provider error burst would then exhaust the pool. Cancelling
    // discards without buffering, so the body is never read into memory.
    const cancel = vi.fn(async () => {});
    global.fetch = vi.fn(async () => failingResponse(cancel)) as unknown as typeof fetch;

    const err = await createRequest();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(err!.status).toBe(422);
  });

  it("still reports the provider failure when cancelling the body fails", async () => {
    // Cleanup must never mask what actually went wrong upstream.
    const cancel = vi.fn(async () => {
      throw new Error("stream already locked");
    });
    global.fetch = vi.fn(async () => failingResponse(cancel)) as unknown as typeof fetch;

    const err = await createRequest();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(Error);
    expect(err!.status).toBe(422);
    expect(err!.message).toContain("HTTP 422");
    // The cleanup failure must not surface in place of the provider failure,
    // and must not smuggle the body back in.
    expect(err!.message).not.toContain("stream already locked");
    expect(err!.message).not.toContain("internal-token-abc123");
  });
});
