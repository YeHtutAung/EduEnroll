import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── GET /api/admin/stats/telegram ──────────────────────────────────────────
// Returns Telegram stats for language_school tenants.

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const supabase = createAdminClient();

  // Verify this is a language_school with telegram enabled
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("org_type, telegram_enabled")
    .eq("id", tenantId)
    .single()) as {
    data: { org_type: string; telegram_enabled: boolean } | null;
    error: unknown;
  };

  if (!tenant || tenant.org_type !== "language_school" || !tenant.telegram_enabled) {
    return NextResponse.json({ linked: 0, pending: 0, channels: 0 });
  }

  // Run counts in parallel
  const [linkedResult, pendingResult, channelResult] = (await Promise.all([
    supabase
      .from("enrollments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .not("telegram_chat_id", "is", null),
    supabase
      .from("enrollments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .not("telegram_link_pending_chat_id", "is", null),
    supabase
      .from("class_channels")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId),
  ])) as unknown as { count: number | null }[];

  return NextResponse.json({
    linked: linkedResult.count ?? 0,
    pending: pendingResult.count ?? 0,
    channels: channelResult.count ?? 0,
  });
}
