// Client-level coverage for the hosted-Checkout return (PR #205 review):
// HTTP 500, network rejection, pending, conflict, and confirmed. The old
// inline handler parsed a 500 body normally (fetch does not reject on HTTP
// errors), found no `status`, did nothing — and left "Verifying Payment…"
// up forever. The helper's contract is: NO outcome leaves a spinner.
import { describe, it, expect, vi } from "vitest";
import { verifyStripeReturn } from "@/lib/payments/verifyStripeReturn";

const ok = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;
const http500 = () =>
  ({ ok: false, status: 500, json: async () => ({ error: "retry" }) }) as unknown as Response;

const noSleep = () => Promise.resolve();

function seq(...responses: (Response | Error)[]) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  });
}

describe("verifyStripeReturn — no outcome leaves a spinner", () => {
  it("confirmed → {kind:'status'}", async () => {
    const fetchImpl = seq(ok({ status: "confirmed" }));
    const out = await verifyStripeReturn({ sessionId: "cs_1", fetchImpl, sleep: noSleep });
    expect(out).toEqual({ kind: "status", status: "confirmed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("settlement_conflict → terminal {kind:'conflict'}, no further retries", async () => {
    const fetchImpl = seq(ok({ status: "settlement_conflict" }));
    const out = await verifyStripeReturn({ sessionId: "cs_1", fetchImpl, sleep: noSleep });
    expect(out).toEqual({ kind: "conflict" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("HTTP 500 (retryable settlement) → bounded retries, then pending_confirmation", async () => {
    const fetchImpl = seq(http500());
    const out = await verifyStripeReturn({ sessionId: "cs_1", fetchImpl, maxAttempts: 4, sleep: noSleep });
    expect(out).toEqual({ kind: "pending_confirmation" });
    expect(fetchImpl).toHaveBeenCalledTimes(4); // bounded, never infinite
  });

  it("HTTP 500 then success → recovers to the enrollment status", async () => {
    const fetchImpl = seq(http500(), http500(), ok({ status: "confirmed" }));
    const out = await verifyStripeReturn({ sessionId: "cs_1", fetchImpl, sleep: noSleep });
    expect(out).toEqual({ kind: "status", status: "confirmed" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("network rejection → retried, then pending_confirmation (never a silent catch)", async () => {
    const fetchImpl = seq(new Error("network down"));
    const out = await verifyStripeReturn({ sessionId: "cs_1", fetchImpl, maxAttempts: 3, sleep: noSleep });
    expect(out).toEqual({ kind: "pending_confirmation" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("network rejection then success → recovers", async () => {
    const fetchImpl = seq(new Error("blip"), ok({ status: "payment_submitted" }));
    const out = await verifyStripeReturn({ sessionId: "cs_1", fetchImpl, sleep: noSleep });
    expect(out).toEqual({ kind: "status", status: "payment_submitted" });
  });

  it("persistent 'pending' → retried (webhook may land), then pending_confirmation", async () => {
    const fetchImpl = seq(ok({ status: "pending" }));
    const out = await verifyStripeReturn({ sessionId: "cs_1", fetchImpl, maxAttempts: 3, sleep: noSleep });
    expect(out).toEqual({ kind: "pending_confirmation" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("'pending' then confirmed → the late webhook wins", async () => {
    const fetchImpl = seq(ok({ status: "pending" }), ok({ status: "confirmed" }));
    const out = await verifyStripeReturn({ sessionId: "cs_1", fetchImpl, sleep: noSleep });
    expect(out).toEqual({ kind: "status", status: "confirmed" });
  });

  it("bodies without a status (the exact old-bug shape) are treated as retryable", async () => {
    const fetchImpl = seq(ok({ error: "retry" }), ok({ status: "confirmed" }));
    const out = await verifyStripeReturn({ sessionId: "cs_1", fetchImpl, sleep: noSleep });
    expect(out).toEqual({ kind: "status", status: "confirmed" });
  });

  it("backoff delays are consulted between attempts, not before the first", async () => {
    const delays: number[] = [];
    const fetchImpl = seq(http500(), http500(), ok({ status: "confirmed" }));
    await verifyStripeReturn({
      sessionId: "cs_1",
      fetchImpl,
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(delays).toEqual([1000, 2000]); // 2^0, 2^1 seconds
  });

  it("session id is URI-encoded into the query", async () => {
    const fetchImpl = seq(ok({ status: "confirmed" }));
    await verifyStripeReturn({ sessionId: "cs 1&x=y", fetchImpl, sleep: noSleep });
    expect(fetchImpl.mock.calls[0][0]).toContain("session_id=cs%201%26x%3Dy");
  });
});
