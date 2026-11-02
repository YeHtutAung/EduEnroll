// ─── Announcement recipients ────────────────────────────────────────────────
// The one definition of who an announcement reaches, used by both the send and
// the count shown before it, so the two cannot disagree.

import type { createAdminClient } from "@/lib/supabase/admin";

// Owner decision 2026-11-03: anyone who has paid something and was not rejected.
// A venue or time change still affects a buyer whose payment is under review.
const RECIPIENT_STATUSES = ["confirmed", "partial_payment", "payment_submitted"];

// PostgREST returns at most this many rows however large the limit asked for.
const PAGE_SIZE = 1000;

type ChatIdPage = { data: { telegram_chat_id: string }[] | null; error: unknown };

async function readAllChatIds(
  readPage: (from: number, to: number) => PromiseLike<ChatIdPage>,
): Promise<string[]> {
  const chatIds: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await readPage(from, from + PAGE_SIZE - 1);
    if (error || !data) throw error ?? new Error("no data");
    chatIds.push(...data.map((row) => row.telegram_chat_id));
    if (data.length < PAGE_SIZE) return chatIds;
  }
}

/** Unique Telegram chat ids for an intake and optional class level. Null if a read failed. */
export async function getAnnouncementRecipients(
  supabase: ReturnType<typeof createAdminClient>,
  target: { tenantId: string; intakeId: string; classLevel: string | null },
): Promise<string[] | null> {
  const { tenantId, intakeId, classLevel } = target;

  try {
    // enrollments has no intake or level of its own; both live on classes.
    let classQuery = supabase
      .from("classes")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("intake_id", intakeId);
    if (classLevel) classQuery = classQuery.eq("level", classLevel);

    const { data: classes, error } = (await classQuery) as {
      data: { id: string }[] | null;
      error: unknown;
    };
    if (error || !classes) throw error ?? new Error("no data");
    if (classes.length === 0) return [];

    const classIds = classes.map((c) => c.id);

    const baseQuery = (columns: string) =>
      supabase
        .from("enrollments")
        .select(columns)
        .eq("tenant_id", tenantId)
        .is("internal_test_at", null)
        .not("telegram_chat_id", "is", null)
        .in("status", RECIPIENT_STATUSES as never);

    const [direct, cart] = await Promise.all([
      readAllChatIds((from, to) =>
        baseQuery("telegram_chat_id")
          .in("class_id", classIds)
          .order("id")
          .range(from, to) as unknown as PromiseLike<ChatIdPage>,
      ),
      // A cart order's classes are on enrollment_items; its class_id can be null.
      readAllChatIds((from, to) =>
        baseQuery("telegram_chat_id, enrollment_items!inner(class_id)")
          .in("enrollment_items.class_id", classIds)
          .order("id")
          .range(from, to) as unknown as PromiseLike<ChatIdPage>,
      ),
    ]);

    return Array.from(new Set([...direct, ...cart]));
  } catch (err) {
    console.error("[announcement-recipients] read failed for", tenantId, err);
    return null;
  }
}
