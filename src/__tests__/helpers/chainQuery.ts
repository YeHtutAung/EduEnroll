import { vi } from "vitest";

/**
 * A Supabase query-builder stand-in: every filter returns the builder, and
 * awaiting it — or calling single / maybeSingle — gives `result`.
 */
export function chainQuery(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "range", "update", "insert", "filter"]) {
    q[m] = vi.fn(() => q);
  }
  q.single = vi.fn(async () => result);
  q.maybeSingle = vi.fn(async () => result);
  q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}
