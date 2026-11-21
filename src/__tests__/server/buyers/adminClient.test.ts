import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timedFetch, TIMEOUT_MS } from "@/server/buyers/adminClient";

// ─── timedFetch: every admin request stops after 5 s ────────────────────────
// Mobile spec 4.1 step 2. The limit must hold even when supabase-js passes
// its own signal.
//
// AbortSignal.timeout runs on Node's internal timers, which fake timers don't
// drive, so the timeout signal is replaced by one the test aborts by hand.

let fired: AbortController;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fired = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => fired.signal);
  fetchMock = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sentSignal = () => (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;

describe("timedFetch", () => {
  it("the limit is 5 seconds", () => {
    expect(TIMEOUT_MS).toBe(5_000);
  });

  it("with no caller signal, sends a signal that aborts when 5 s pass", async () => {
    await timedFetch("https://example.test/x", { method: "POST" });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5_000);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const signal = sentSignal();
    expect(signal.aborted).toBe(false);
    fired.abort(new DOMException("timed out", "TimeoutError"));
    expect(signal.aborted).toBe(true);
  });

  it("with a caller signal, still aborts when 5 s pass", async () => {
    const caller = new AbortController();
    await timedFetch("https://example.test/x", { signal: caller.signal });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5_000);
    const signal = sentSignal();
    expect(signal.aborted).toBe(false);
    fired.abort(new DOMException("timed out", "TimeoutError"));
    expect(signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it("with a caller signal, the caller's abort still aborts the request", async () => {
    const caller = new AbortController();
    await timedFetch("https://example.test/x", { signal: caller.signal });
    const signal = sentSignal();
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("timedFetch with real timers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("really aborts on Node's AbortSignal.timeout (short wait, same code path)", async () => {
    // Shrink the real timeout to 20 ms for this one check of the real API.
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(20));
    const caller = new AbortController();
    await timedFetch("https://example.test/x", { signal: caller.signal });
    const signal = sentSignal();
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(signal.aborted).toBe(true);
  });
});
