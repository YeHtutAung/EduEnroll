import { vi } from "vitest";

// ─── Chainable query builder mock ────────────────────────────────────────────
// Simulates Supabase's fluent query API: .from().select().eq().single()

export interface MockQueryResult<T> {
  data: T | null;
  error: null | { message: string };
}

export function makeChainMock<T>(result: MockQueryResult<T>) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "eq", "neq", "order", "limit", "maybeSingle", "single", "update", "insert", "delete", "upsert"];
  methods.forEach((m) => {
    chain[m] = vi.fn().mockReturnValue(chain);
  });
  // Terminal: awaiting the chain returns the result
  chain.then = (resolve: (v: MockQueryResult<T>) => void) => resolve(result);
  return chain;
}

// ─── Admin client mock factory ────────────────────────────────────────────────

export interface MockSupabaseClient {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
}

export function makeAdminClientMock(): MockSupabaseClient {
  return {
    from: vi.fn(),
    rpc: vi.fn(),
  };
}
