import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/messenger/crypto";
// ─── POST /api/admin/announcements/[id]/dispatch ──────────────────────────────
// Dispatches an announcement to students via Telegram.
// Finds all enrollments with telegram_chat_id matching the announcement's
// intake + class_level, deduplicates by chat_id, and sends the message.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;
  const { id } = await params;

  const supabase = createAdminClient();

  // ── Fetch the announcement ─────────────────────────────────────────────────
  const { data: announcement } = (await supabase
    .from("announcements")
    .select("id, intake_id, class_level, target_label, message, dispatched_at")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      intake_id: string | null;
      class_level: string | null;
      target_label: string;
      message: string;
      dispatched_at: string | null;
    } | null;
    error: unknown;
  };

  if (!announcement) {
    return NextResponse.json({ error: "Announcement not found." }, { status: 404 });
  }

  if (announcement.dispatched_at) {
    return NextResponse.json(
      { error: "This announcement has already been dispatched." },
      { status: 409 },
    );
  }

  // ── Check tenant has Telegram configured ───────────────────────────────────
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("telegram_enabled, telegram_bot_token")
    .eq("id", tenantId)
    .single()) as {
    data: { telegram_enabled: boolean; telegram_bot_token: string | null } | null;
    error: unknown;
  };

  if (!tenant?.telegram_enabled || !tenant.telegram_bot_token) {
    return NextResponse.json(
      { error: "Telegram bot is not connected or enabled." },
      { status: 400 },
    );
  }

  const botToken = decryptToken(tenant.telegram_bot_token);

  // ── Find target enrollments with telegram_chat_id ──────────────────────────
  let query = supabase
    .from("enrollments")
    .select("telegram_chat_id")
    .eq("tenant_id", tenantId)
    .not("telegram_chat_id", "is", null);

  if (announcement.intake_id) {
    query = query.eq("intake_id", announcement.intake_id);
  }
  if (announcement.class_level) {
    query = query.eq("class_level", announcement.class_level);
  }

  const { data: enrollments } = (await query) as {
    data: { telegram_chat_id: string }[] | null;
    error: unknown;
  };

  if (!enrollments || enrollments.length === 0) {
    // Mark as dispatched with 0 sent
    await supabase
      .from("announcements")
      .update({
        telegram_sent_count: 0,
        telegram_failed_count: 0,
        dispatched_at: new Date().toISOString(),
      } as never)
      .eq("id", id);

    return NextResponse.json({
      sent: 0,
      failed: 0,
      message: "No students with Telegram connected for this target.",
    });
  }

  // ── Deduplicate by chat_id ─────────────────────────────────────────────────
  const uniqueChatIds = Array.from(new Set(enrollments.map((e) => e.telegram_chat_id)));

  // ── Format and send ────────────────────────────────────────────────────────
  const text =
    `📢 <b>${announcement.target_label}</b>\n\n` + announcement.message;

  let sent = 0;
  let failed = 0;

  for (const chatId of uniqueChatIds) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        },
      );
      if (res.ok) {
        sent++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  // ── Update announcement with dispatch results ──────────────────────────────
  await supabase
    .from("announcements")
    .update({
      telegram_sent_count: sent,
      telegram_failed_count: failed,
      dispatched_at: new Date().toISOString(),
    } as never)
    .eq("id", id);

  return NextResponse.json({ sent, failed });
}
