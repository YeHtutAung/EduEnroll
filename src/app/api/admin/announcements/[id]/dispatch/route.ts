import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEnrollmentBotToken } from "@/lib/telegram/enrollment-bot";
import { getAnnouncementRecipients } from "@/lib/announcements/announcementRecipients";

export const maxDuration = 60;

// Telegram allows about 30 messages a second across a bot's chats.
const BATCH_SIZE = 25;
const BATCH_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;
// Leaves time inside maxDuration to write the result. At one batch a second that
// is about 1,150 recipients per send; anyone past that is recorded as unsent.
const SEND_BUDGET_MS = 50_000;
const TELEGRAM_MESSAGE_LIMIT = 4096;

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryAfterMs(res: Response): Promise<number> {
  const body = (await res.json().catch(() => null)) as {
    parameters?: { retry_after?: number };
  } | null;
  return (body?.parameters?.retry_after ?? 1) * 1000;
}

// ─── POST /api/admin/announcements/[id]/dispatch ──────────────────────────────
// Sends an announcement to its recipients via Telegram, at most once.
//
// dispatched_at is the claim: only one request can set it, and nothing is sent
// without it. Everything that can refuse a send happens first, so a refused
// announcement stays sendable. Once claimed, an announcement is never sent again,
// because a missed message is better than a duplicate to every buyer. If the send
// stops early, dispatch_completed_at stays null and the counts show how far it got.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOwner();
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

  // The intake is cleared when it is deleted. Without one there is no target.
  if (!announcement.intake_id) {
    return NextResponse.json(
      { error: "The intake for this announcement no longer exists." },
      { status: 400 },
    );
  }

  // ── Format ─────────────────────────────────────────────────────────────────
  // Telegram measures the text after parsing, so the limit applies to it unescaped.
  const header = `📢 ${announcement.target_label}\n\n`;
  if (header.length + announcement.message.length > TELEGRAM_MESSAGE_LIMIT) {
    return NextResponse.json(
      { error: `Telegram messages can be at most ${TELEGRAM_MESSAGE_LIMIT} characters.` },
      { status: 400 },
    );
  }

  const text =
    `📢 <b>${escapeHtml(announcement.target_label)}</b>\n\n` + escapeHtml(announcement.message);

  // ── Check tenant has Telegram configured ───────────────────────────────────
  const bot = await getEnrollmentBotToken(supabase, tenantId, "announcement-dispatch");

  if (bot.status === "failed") {
    return NextResponse.json(
      { error: "Could not load the Telegram bot." },
      { status: 500 },
    );
  }

  if (bot.status !== "ready") {
    return NextResponse.json(
      { error: "Telegram bot is not connected or enabled." },
      { status: 400 },
    );
  }

  const { botToken } = bot;

  // ── Find recipients ────────────────────────────────────────────────────────
  const recipients = await getAnnouncementRecipients(supabase, {
    tenantId,
    intakeId: announcement.intake_id,
    classLevel: announcement.class_level,
  });

  if (!recipients) {
    return NextResponse.json({ error: "Could not read the recipients." }, { status: 500 });
  }

  // ── Claim ──────────────────────────────────────────────────────────────────
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = (await supabase
    .from("announcements")
    .update({
      dispatched_at: claimedAt,
      telegram_recipient_count: recipients.length,
      dispatch_completed_at: recipients.length === 0 ? claimedAt : null,
    } as never)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("dispatched_at", null)
    .select("id")) as { data: { id: string }[] | null; error: unknown };

  if (claimError) {
    console.error("[announcement-dispatch] claim failed for", id, claimError);
    return NextResponse.json({ error: "Could not start the send." }, { status: 500 });
  }

  if (!claimed || claimed.length === 0) {
    return NextResponse.json(
      { error: "This announcement has already been dispatched." },
      { status: 409 },
    );
  }

  if (recipients.length === 0) {
    return NextResponse.json({
      sent: 0,
      failed: 0,
      unsent: 0,
      completed: true,
      message: "No students with Telegram connected for this target.",
    });
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  const startedAt = Date.now();
  const queue = [...recipients];
  const rateLimitedOnce = new Set<string>();
  let sent = 0;
  let failed = 0;

  const saveCounts = async (extra: Record<string, unknown> = {}) => {
    const { error } = await supabase
      .from("announcements")
      .update({ telegram_sent_count: sent, telegram_failed_count: failed, ...extra } as never)
      .eq("id", id);
    if (error) console.error("[announcement-dispatch] could not save counts for", id, error);
  };

  while (queue.length > 0) {
    if (Date.now() - startedAt + REQUEST_TIMEOUT_MS > SEND_BUDGET_MS) break;

    const batchStartedAt = Date.now();
    const batch = queue.splice(0, BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((chatId) =>
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      ),
    );

    // A 429 was certainly not delivered, so it alone is safe to send again.
    // A timeout may have been delivered, so it counts as failed.
    let waitMs = 0;
    const retry: string[] = [];
    for (const [i, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value.ok) {
        sent++;
      } else if (result.status === "fulfilled" && result.value.status === 429 && !rateLimitedOnce.has(batch[i])) {
        rateLimitedOnce.add(batch[i]);
        retry.push(batch[i]);
        waitMs = Math.max(waitMs, await retryAfterMs(result.value));
      } else {
        failed++;
      }
    }
    queue.unshift(...retry);
    if (queue.length === 0) break;

    await saveCounts();

    waitMs = Math.max(waitMs, BATCH_INTERVAL_MS - (Date.now() - batchStartedAt));
    if (Date.now() - startedAt + waitMs + REQUEST_TIMEOUT_MS > SEND_BUDGET_MS) break;
    await sleep(waitMs);
  }

  // ── Record the result ──────────────────────────────────────────────────────
  const completed = queue.length === 0;
  await saveCounts(completed ? { dispatch_completed_at: new Date().toISOString() } : {});

  const unsent = queue.length;
  if (failed > 0 || unsent > 0) {
    console.error("[announcement-dispatch]", id, { sent, failed, unsent });
  }

  return NextResponse.json({ sent, failed, unsent, completed });
}
