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

afterEach(() => vi.restoreAllMocks());

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
    expect(counts).toEqual({ expired: 0, contextDeleted: 0, processed: 1 });
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("[conversions] clean-up failed:", "57014");
  });

  it("returns the clean-up counts", async () => {
    pendingRows = { data: rowsFor("enr-1", "enr-2"), error: null };

    await expect(sweepConversions()).resolves.toEqual({ expired: 2, contextDeleted: 3, processed: 2 });
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

  it("processes at most 40 enrollments", async () => {
    pendingRows = { data: rowsFor(...manyIds(100)), error: null };

    const counts = await sweepConversions();

    expect(query.limit).toBe(80);
    expect(mockSend).toHaveBeenCalledTimes(40);
    expect(mockSend.mock.calls[39][0]).toBe("enr-39");
    expect(counts.processed).toBe(40);
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

    await expect(sweepConversions()).resolves.toEqual({ expired: 2, contextDeleted: 3, processed: 0 });

    expect(mockSend).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("[conversions] pending read failed:", "08006");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("SECRET-VALUE");
  });

  it("does nothing more when no rows are pending", async () => {
    await expect(sweepConversions()).resolves.toEqual({ expired: 2, contextDeleted: 3, processed: 0 });

    expect(mockSend).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
