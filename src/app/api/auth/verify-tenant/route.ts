import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveTenantId } from "@/lib/api";
import type { User } from "@/types/database";

// ─── GET /api/auth/verify-tenant ──────────────────────────────────────────────
// Checks that the currently authenticated user belongs to the tenant identified
// by the x-tenant-slug header (set by middleware). Returns 200 on success,
// 401 if not logged in, 403 if tenant mismatch.

export async function GET() {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const supabase = createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "Unauthorized", message: "Not logged in." },
      { status: 401 },
    );
  }

  const { data: profile } = (await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single()) as { data: Pick<User, "tenant_id"> | null; error: unknown };

  if (!profile || profile.tenant_id !== tenantId) {
    return NextResponse.json(
      {
        error: "Forbidden",
        message: "Your account does not belong to this school.",
        message_mm: "သင့်အကောင့်သည် ဤကျောင်းနှင့် သက်ဆိုင်မှုမရှိပါ။",
      },
      { status: 403 },
    );
  }

  return NextResponse.json({ ok: true });
}
