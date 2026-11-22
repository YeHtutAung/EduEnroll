import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { isAccountEmailKey } from "@/lib/enrollment/accountEmail";

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

// ─── withAccountEmail ────────────────────────────────────────────────────────
// A protected order's email is the account's verified email, whatever the form
// said (design 5.2). Returns a copy of the form answers with every email field
// the order and its emails read from (isAccountEmailKey: email, email_address,
// custom_email_*) set to `email`; `email` itself is always set, even if the
// form had none. The form and checkout pages lock exactly these fields.

export function withAccountEmail(
  fd: Record<string, string>,
  email: string,
): Record<string, string> {
  const out: Record<string, string> = { ...fd, email };
  for (const key of Object.keys(out)) {
    if (isAccountEmailKey(key)) out[key] = email;
  }
  return out;
}
