import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { User } from "@/types/database";

export type SuperadminAuth = { error: NextResponse } | { profile: User };

/**
 * Require a signed-in user whose profile role is "superadmin".
 * Returns { error } (a 401 or 403 response to send back as is) or
 * { profile } (the caller's users row). Narrow with `"error" in auth`.
 */
export async function requireSuperadmin(): Promise<SuperadminAuth> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const { data: profile } = (await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single()) as { data: User | null; error: unknown };

  if (!profile || profile.role !== "superadmin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { profile };
}
