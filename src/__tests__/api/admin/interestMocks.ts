// Shared Supabase stub for the three /api/admin/interest routes.
//
// Not a .test.ts file, so vitest imports it rather than collecting it.
//
// The routes chain a variable number of .eq()/.is()/.order()/.limit() calls
// before awaiting the builder (or calling .maybeSingle()), so each builder here
// is both chainable and awaitable. What it resolves to depends on what was
// recorded on the way — which is how one `from("event_interest")` stub serves
// the candidate read, the post-rotation read-back, the stamp, and the remaining
// count, exactly as the real client does.

import { vi } from "vitest";

export interface RecordedUpdate {
  payload: Record<string, unknown>;
  eqs: Record<string, unknown>;
}

export interface RecordedRpc {
  name: string;
  args: Record<string, unknown>;
}

export interface InterestMockOptions {
  intake?: { data: unknown; error?: unknown };
  classes?: { data: unknown; error?: unknown };
  tenant?: { data: unknown; error?: unknown };
  /** Rows returned by the list read and the invite candidate read. */
  entries?: { data: unknown; error?: unknown };
  /** Row returned by the single-entry lookup in the entry route. */
  entry?: { data: unknown; error?: unknown };
  /** Value for the post-rotation `superseded_expires_at` read-back. */
  supersededExpiresAt?: string | null;
  /** Result of `rotate_interest_token`, per call or fixed. */
  rotate?: (args: Record<string, unknown>) => unknown;
  /** Result of `rollback_interest_rotation`. */
  rollback?: (args: Record<string, unknown>) => unknown;
  /** Value the `{ count: "exact", head: true }` read returns. */
  remainingCount?: number | null;
}

export interface InterestMock {
  client: { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> };
  /**
   * event_interest row ids whose UPDATE should report an error. Lets a test
   * fail the bookkeeping write while the send itself succeeded — the state
   * that makes a row deliverable AND still eligible.
   */
  stampErrorForIds: Set<string>;
  updates: RecordedUpdate[];
  rpcCalls: RecordedRpc[];
  /** Every `select()` column string the code asked for, in order. */
  selectedColumns: string[];
  /** Every `.is(column, value)` filter applied to event_interest. */
  isFilters: { column: string; value: unknown }[];
}

const ok = (result: { data?: unknown; error?: unknown; count?: unknown }) => ({
  data: null,
  error: null,
  ...result,
});

export function makeInterestMock(opts: InterestMockOptions = {}): InterestMock {
  const updates: RecordedUpdate[] = [];
  const stampErrorForIds = new Set<string>();
  const rpcCalls: RecordedRpc[] = [];
  const selectedColumns: string[] = [];
  const isFilters: { column: string; value: unknown }[] = [];

  /** A plain chainable that always resolves to one fixed result. */
  function fixed(result: { data?: unknown; error?: unknown }) {
    const resolved = ok(result);
    const obj: Record<string, unknown> = {
      then: (resolve: (v: unknown) => void) => resolve(resolved),
    };
    for (const method of ["select", "eq", "in", "is", "not", "order", "limit"]) {
      obj[method] = vi.fn().mockReturnValue(obj);
    }
    obj.maybeSingle = vi.fn().mockResolvedValue(resolved);
    obj.single = vi.fn().mockResolvedValue(resolved);
    return obj;
  }

  /** event_interest: what it resolves to depends on how it was built. */
  function eventInterest() {
    const state: {
      mode: "select" | "update" | null;
      cols: string;
      head: boolean;
      payload: Record<string, unknown>;
      eqs: Record<string, unknown>;
    } = { mode: null, cols: "", head: false, payload: {}, eqs: {} };

    function resolve(single = false) {
      if (state.mode === "update") {
        updates.push({ payload: state.payload, eqs: { ...state.eqs } });
        if (typeof state.eqs.id === "string" && stampErrorForIds.has(state.eqs.id)) {
          return ok({ error: { message: "stamp failed" } });
        }
        return ok({});
      }

      // The remaining-count read.
      if (state.head) {
        const count = opts.remainingCount;
        return count === null || count === undefined
          ? ok({ error: { message: "count failed" }, count: null })
          : ok({ count });
      }

      // rotateAndSend's post-rotation read-back.
      if (state.cols === "superseded_expires_at") {
        return ok({ data: { superseded_expires_at: opts.supersededExpiresAt ?? null } });
      }

      // Any single-row read of event_interest: the entry route's lookup, and
      // its read-back through the display allowlist.
      if (single) return ok(opts.entry ?? { data: null });

      // The list read and the invite candidate read.
      return ok(opts.entries ?? { data: [] });
    }

    const obj: Record<string, unknown> = {
      select: vi.fn((cols: string, o?: { head?: boolean }) => {
        state.mode = "select";
        state.cols = cols;
        state.head = o?.head === true;
        selectedColumns.push(cols);
        return obj;
      }),
      update: vi.fn((payload: Record<string, unknown>) => {
        state.mode = "update";
        state.payload = payload;
        return obj;
      }),
      eq: vi.fn((col: string, val: unknown) => {
        state.eqs[col] = val;
        return obj;
      }),
      is: vi.fn((col: string, val: unknown) => {
        isFilters.push({ column: col, value: val });
        return obj;
      }),
      order: vi.fn(() => obj),
      limit: vi.fn(() => obj),
      in: vi.fn(() => obj),
      then: (resolve_: (v: unknown) => void) => resolve_(resolve(false)),
      maybeSingle: vi.fn(async () => resolve(true)),
      single: vi.fn(async () => resolve(true)),
    };
    return obj;
  }

  const client = {
    from: vi.fn((table: string) => {
      if (table === "intakes") return fixed(opts.intake ?? { data: null });
      if (table === "classes") return fixed(opts.classes ?? { data: [] });
      if (table === "tenants") {
        return fixed(
          opts.tenant ?? { data: { name: "Acme Events", subdomain: "acme", logo_url: null } },
        );
      }
      if (table === "event_interest") return eventInterest();
      return fixed({ data: null });
    }),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "rotate_interest_token") {
        return ok({ data: opts.rotate ? opts.rotate(args) : "ROTATED" });
      }
      if (name === "rollback_interest_rotation") {
        return ok({ data: opts.rollback ? opts.rollback(args) : true });
      }
      return ok({ data: null });
    }),
  };

  return { client, stampErrorForIds, updates, rpcCalls, selectedColumns, isFilters };
}

/** An intake whose priority window is scheduled — the normal case. */
export function scheduledIntake(overrides: Record<string, unknown> = {}) {
  return {
    id: "intake-1",
    name: "Summer Fest",
    slug: "summer-fest",
    status: "open",
    priority_open_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

export const OWNER_TENANT = "tenant-owner";
