import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollWhileVisible } from "@/lib/admin/pollWhileVisible";

type Visibility = "visible" | "hidden";

// The test environment is node, so this stands in for the only parts of
// `document` the helper touches.
function fakeDocument(initial: Visibility) {
  const listeners = new Set<() => void>();
  return {
    visibilityState: initial as Visibility,
    addEventListener: (_: "visibilitychange", fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: "visibilitychange", fn: () => void) => void listeners.delete(fn),
    set(state: Visibility) {
      this.visibilityState = state;
      listeners.forEach((fn) => fn());
    },
    listenerCount: () => listeners.size,
  };
}

const INTERVAL = 30_000;

describe("pollWhileVisible", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs on the interval while the tab is visible, and not straight away", () => {
    const run = vi.fn();
    pollWhileVisible(run, INTERVAL, fakeDocument("visible"));

    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INTERVAL * 3);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("doesn't run at all in a tab that starts hidden", () => {
    const run = vi.fn();
    pollWhileVisible(run, INTERVAL, fakeDocument("hidden"));

    vi.advanceTimersByTime(INTERVAL * 10);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops when the tab is hidden", () => {
    const run = vi.fn();
    const doc = fakeDocument("visible");
    pollWhileVisible(run, INTERVAL, doc);

    vi.advanceTimersByTime(INTERVAL);
    expect(run).toHaveBeenCalledTimes(1);

    doc.set("hidden");
    vi.advanceTimersByTime(INTERVAL * 10);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("catches up once when the tab returns after the data has gone stale, then resumes", () => {
    const run = vi.fn();
    const doc = fakeDocument("visible");
    pollWhileVisible(run, INTERVAL, doc);

    doc.set("hidden");
    vi.advanceTimersByTime(INTERVAL * 10);
    doc.set("visible");
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(INTERVAL);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("doesn't catch up when the tab was only hidden briefly", () => {
    const run = vi.fn();
    const doc = fakeDocument("visible");
    pollWhileVisible(run, INTERVAL, doc);

    vi.advanceTimersByTime(1_000);
    doc.set("hidden");
    vi.advanceTimersByTime(1_000);
    doc.set("visible");
    expect(run).not.toHaveBeenCalled();
  });

  it("doesn't start a second timer when visible is reported twice", () => {
    const run = vi.fn();
    const doc = fakeDocument("visible");
    pollWhileVisible(run, INTERVAL, doc);

    doc.set("visible");
    vi.advanceTimersByTime(INTERVAL);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops everything on clean-up", () => {
    const run = vi.fn();
    const doc = fakeDocument("visible");
    const stop = pollWhileVisible(run, INTERVAL, doc);

    stop();
    vi.advanceTimersByTime(INTERVAL * 10);
    expect(run).not.toHaveBeenCalled();
    expect(doc.listenerCount()).toBe(0);
  });
});
