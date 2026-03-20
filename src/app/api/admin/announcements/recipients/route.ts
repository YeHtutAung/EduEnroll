import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";

// ─── GET /api/admin/announcements/recipients ──────────────────────────────────
// Returns count of unique Telegram recipients for a given intake + class_level.
// Query params: intake_id (required), class_level (optional)

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const intakeId = request.nextUrl.searchParams.get("intake_id");
  if (!intakeId) {
    return NextResponse.json({ count: 0 });
  }

  let query = supabase
    .from("enrollments")
    .select("telegram_chat_id")
    .eq("tenant_id", tenantId)
    .eq("intake_id", intakeId)
    .not("telegram_chat_id", "is", null);

  const classLevel = request.nextUrl.searchParams.get("class_level");
  if (classLevel) {
    query = query.eq("class_level", classLevel);
  }

  const { data } = (await query) as {
    data: { telegram_chat_id: string }[] | null;
    error: unknown;
  };

  const uniqueCount = new Set(data?.map((e) => e.telegram_chat_id) ?? []).size;

  return NextResponse.json({ count: uniqueCount });
}
