import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/telegram/crypto";
import { sendTelegramMessage } from "@/lib/telegram";

// ─── GET /api/telegram/admin-requests ────────────────────────────────────────
// Returns all pending support bot access requests for the tenant.

export async function GET() {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("telegram_admin_requests")
    .select("id, chat_id, name, username, status, created_at")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[admin-requests] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch requests." }, { status: 500 });
  }

  return NextResponse.json({ requests: data ?? [] });
}

// ─── PATCH /api/telegram/admin-requests ──────────────────────────────────────
// Approve or reject a pending request.
// Body: { id: string, action: "approve" | "reject" }

export async function PATCH(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  let body: { id: string; action: "approve" | "reject" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.id || !["approve", "reject"].includes(body.action)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Fetch the request — verify it belongs to this tenant
  const { data: req } = (await supabase
    .from("telegram_admin_requests")
    .select("id, chat_id, name, tenant_id")
    .eq("id", body.id)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: { id: string; chat_id: number; name: string; tenant_id: string } | null;
    error: unknown;
  };

  if (!req) {
    return NextResponse.json({ error: "Request not found." }, { status: 404 });
  }

  // Fetch support bot token for notification
  const { data: bot } = (await supabase
    .from("tenant_bots")
    .select("bot_token")
    .eq("tenant_id", tenantId)
    .eq("bot_type", "support")
    .single()) as {
    data: { bot_token: string | null } | null;
    error: unknown;
  };

  // Fetch current allowed_chat_ids
  const { data: config } = (await supabase
    .from("tenant_telegram_configs")
    .select("allowed_chat_ids")
    .eq("tenant_id", tenantId)
    .single()) as {
    data: { allowed_chat_ids: number[] | null } | null;
    error: unknown;
  };

  let botToken: string | null = null;
  if (bot?.bot_token) {
    try {
      botToken = decryptToken(bot.bot_token);
    } catch {
      console.error("[admin-requests] Failed to decrypt support bot token");
    }
  }

  if (body.action === "approve") {
    // Append chat_id to allowed_chat_ids — upsert so the row is created if missing
    const current = (config?.allowed_chat_ids ?? []).map(Number);
    if (!current.includes(req.chat_id)) {
      await supabase
        .from("tenant_telegram_configs")
        .upsert(
          { tenant_id: tenantId, allowed_chat_ids: [...current, req.chat_id] } as never,
          { onConflict: "tenant_id" },
        );
    }

    await supabase
      .from("telegram_admin_requests")
      .update({ status: "approved" } as never)
      .eq("id", req.id);

    if (botToken) {
      await sendTelegramMessage(
        req.chat_id,
        "✅ Your request has been approved. You can now send messages to the support bot.",
        botToken,
      );
    }

    return NextResponse.json({ success: true, action: "approved" });
  }

  // Reject
  await supabase
    .from("telegram_admin_requests")
    .update({ status: "rejected" } as never)
    .eq("id", req.id);

  if (botToken) {
    await sendTelegramMessage(
      req.chat_id,
      "❌ Your request was not approved. Please contact the admin directly.",
      botToken,
    );
  }

  return NextResponse.json({ success: true, action: "rejected" });
}
