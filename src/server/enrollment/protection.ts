import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// ─── protectedClassIds ───────────────────────────────────────────────────────
// The subset of classIds whose class sits on an intake with
// ticket_protection = true (account-bound tickets, design 5).
//
// Returns null when the answer can't be read. Callers MUST treat null as
// "unavailable" (503), never as "not protected": fail closed.

interface Row {
  id: string;
  intakes: { ticket_protection: boolean } | null;
}

export async function protectedClassIds(
  admin: SupabaseClient<Database>,
  classIds: readonly string[],
): Promise<Set<string> | null> {
  const ids = Array.from(new Set(classIds.filter((id) => typeof id === "string" && id !== "")));
  if (ids.length === 0) return new Set();

  try {
    const { data, error } = (await admin
      .from("classes")
      .select("id, intakes!inner(ticket_protection)")
      .in("id", ids)) as unknown as { data: Row[] | null; error: unknown };
    if (error || !Array.isArray(data)) {
      console.error("[protectedClassIds] classes lookup failed");
      return null;
    }
    const out = new Set<string>();
    for (const row of data) {
      if (row.intakes?.ticket_protection === true) out.add(row.id);
    }
    return out;
  } catch {
    console.error("[protectedClassIds] classes lookup threw");
    return null;
  }
}
