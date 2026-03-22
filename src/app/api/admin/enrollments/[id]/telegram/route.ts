import { NextRequest, NextResponse } from "next/server";
import { requireAuth, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── GET /api/admin/enrollments/[id]/telegram ───────────────────────────────
// Returns telegram link status for an enrollment.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;
  const { id } = await params;

  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, telegram_chat_id, telegram_link_pending_chat_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      telegram_chat_id: string | null;
      telegram_link_pending_chat_id: string | null;
    } | null;
    error: unknown;
  };

  if (!enrollment) return notFound("Enrollment");

  return NextResponse.json({
    linked: !!enrollment.telegram_chat_id,
    chatId: enrollment.telegram_chat_id,
    pending: !!enrollment.telegram_link_pending_chat_id,
  });
}

// ─── DELETE /api/admin/enrollments/[id]/telegram ────────────────────────────
// Unlinks telegram from an enrollment (clears chat_id and pending).

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;
  const { id } = await params;

  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single()) as { data: { id: string } | null; error: unknown };

  if (!enrollment) return notFound("Enrollment");

  await supabase
    .from("enrollments")
    .update({
      telegram_chat_id: null,
      telegram_link_pending_chat_id: null,
    } as never)
    .eq("id", id);

  return NextResponse.json({ success: true, message: "Telegram unlinked." });
}
