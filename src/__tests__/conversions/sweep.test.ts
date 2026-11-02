import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock the admin client and the sender ───────────────────────────────────

type DbError = { code: string; message: string } | null;

let events: string[];
let cleanup: { data: unknown; error: DbError };
let pendingRows: { data: { enrollment_id: string }[] | null; error: DbError };
let query: { table?: string; select?: string; filters: [string, unknown][]; order?: unknown[]; limit?: number };

const mockRpc = vi.fn(async (name: string) => {
  events.push(`rpc:${name}`);
  return cleanup;
});

const mockFrom = vi.fn((table: string) => {
  query.table = table;
  const b = {
    select: (columns: string) => ((query.select = columns), b),
    eq: (column: string, value: unknown) => (query.filters.push([column, value]), b),
    order: (...args: unknown[]) => ((query.order = args), b),
    limit: (n: number) => ((query.limit = n), b),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      events.push("read");
      return Promise.resolve(pendingRows).then(resolve, reject);
    },
  };
  return b;
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom, rpc: mockRpc }),
}));

const mockSend = vi.fn();
vi.mock("@/server/conversions/sendPendingConversions", () => ({
  sendPendingConversions: (...a: unknown[]) => mockSend(...a),
}));

const { sweepConversions } = await import("@/server/conversions/sweep");

const rowsFor = (...ids: string[]) => ids.map((enrollment_id) => ({ enrollment_id }));
const manyIds = (n: number) => Array.from({ length: n }, (_, i) => `enr-${i}`);

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  events = [];
  cleanup = { data: [{ expired: 2, context_deleted: 3 }], error: null };
  pendingRows = { data: [], error: null };
  query = { filters: [] };
  mockRpc.mockClear();
  mockFrom.mockClear();
  mockSend.mockReset();
  mockSend.mockImplementation(async (id: string) => {
    events.push(`send:${id}`);
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sweepConversions", () => {
  it("runs clean-up before reading any pending rows", async () => {
    pendingRows = { data: rowsFor("enr-1"), error: null };

    await sweepConversions();

    expect(events).toEqual(["rpc:cleanup_conversion_data", "read", "send:enr-1"]);
  });

  it("still sends when clean-up fails, and logs only the code", async () => {
    cleanup = { data: null, error: { code: "57014", message: "SECRET-VALUE" } };
    pendingRows = { data: rowsFor("enr-1"), error: null };

    const counts = await sweepConversions();

    expect(mockSend).toHaveBeenCalledExactlyOnceWith("enr-1");
    expect(counts).toEqual({ expired: 0, contextDeleted: 0, processed: 1, cleanupFailed: true });
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("[conversions] clean-up failed:", "57014");
  });

  it("returns the clean-up counts", async () => {
    pendingRows = { data: rowsFor("enr-1", "enr-2"), error: null };

    await expect(sweepConversions()).resolves.toEqual({
      expired: 2,
      contextDeleted: 3,
      processed: 2,
      cleanupFailed: false,
    });
  });

  it("reads oldest first, and sends each enrollment once", async () => {
    pendingRows = { data: rowsFor("old", "old", "mid", "new", "mid"), error: null };

    const counts = await sweepConversions();

    expect(query.table).toBe("conversion_events");
    expect(query.select).toBe("enrollment_id");
    expect(query.filters).toEqual([["status", "pending"]]);
    expect(query.order).toEqual(["occurred_at", { ascending: true }]);
    expect(mockSend.mock.calls.map(([id]) => id)).toEqual(["old", "mid", "new"]);
    expect(counts.processed).toBe(3);
  });

  it("reads up to 1,000 rows, and sends all of them while the budget lasts", async () => {
    pendingRows = { data: rowsFor(...manyIds(1000)), error: null };

    const counts = await sweepConversions();

    expect(query.limit).toBe(1000);
    expect(mockSend).toHaveBeenCalledTimes(1000);
    expect(counts.processed).toBe(1000);
  });

  describe("time budget", () => {
    const START = new Date("2026-11-02T20:00:00.000Z").getTime();
    /** Moves the clock while the given chunk (1-based) is running. */
    const clockAfterChunk = (times: Record<number, number>) => {
      let calls = 0;
      mockSend.mockImplementation(async () => {
        const chunk = Math.floor(calls / 5) + 1;
        calls += 1;
        if (times[chunk] !== undefined) vi.setSystemTime(START + times[chunk]);
      });
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START);
      pendingRows = { data: rowsFor(...manyIds(12)), error: null };
    });

    it("starts no new chunk once 45 seconds are spent, and counts only what it started", async () => {
      clockAfterChunk({ 1: 45_000 });

      const counts = await sweepConversions();

      expect(mockSend).toHaveBeenCalledTimes(5);
      expect(counts.processed).toBe(5);
    });

    it("still starts a chunk just inside the budget", async () => {
      clockAfterChunk({ 1: 44_999, 2: 50_000 });

      const counts = await sweepConversions();

      expect(mockSend).toHaveBeenCalledTimes(10);
      expect(counts.processed).toBe(10);
    });

    it("counts the time clean-up took", async () => {
      mockRpc.mockImplementationOnce(async () => {
        vi.setSystemTime(START + 45_000);
        return cleanup;
      });

      const counts = await sweepConversions();

      expect(mockSend).not.toHaveBeenCalled();
      expect(counts.processed).toBe(0);
    });

    it("counts a short last chunk by its real size", async () => {
      const counts = await sweepConversions();

      expect(mockSend).toHaveBeenCalledTimes(12);
      expect(counts.processed).toBe(12);
    });
  });

  it("runs at most 5 at a time", async () => {
    pendingRows = { data: rowsFor(...manyIds(12)), error: null };
    let active = 0;
    let peak = 0;
    mockSend.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    });

    await sweepConversions();

    expect(mockSend).toHaveBeenCalledTimes(12);
    expect(peak).toBe(5);
  });

  it("logs and sends nothing when the pending read fails, keeping the clean-up counts", async () => {
    pendingRows = { data: null, error: { code: "08006", message: "SECRET-VALUE" } };

    await expect(sweepConversions()).resolves.toEqual({
      expired: 2,
      contextDeleted: 3,
      processed: 0,
      cleanupFailed: false,
    });

    expect(mockSend).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("[conversions] pending read failed:", "08006");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("SECRET-VALUE");
  });

  it("does nothing more when no rows are pending", async () => {
    await expect(sweepConversions()).resolves.toEqual({
      expired: 2,
      contextDeleted: 3,
      processed: 0,
      cleanupFailed: false,
    });

    expect(mockSend).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
