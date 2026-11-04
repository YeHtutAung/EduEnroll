// ─── Save, then send ────────────────────────────────────────────────────────
// Browser side of the announcement composer. Saving and sending are separate
// requests so that a send which times out belongs to one saved announcement, and
// the server's claim on that row refuses any second attempt.

import type { AnnouncementRow } from "@/app/api/admin/announcements/route";

export type SendOutcome =
  | { state: "not_requested" }
  | { state: "finished"; sent: number; failed: number; unsent: number; completed: boolean }
  | { state: "refused"; reason: string }
  // The connection was lost or the platform timed out. The send may still be running.
  | { state: "unknown" };

export type SaveAndSendResult =
  | { saved: true; row: AnnouncementRow; send: SendOutcome }
  | { saved: false; reason: string };

async function errorReason(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return body.message ?? body.error ?? fallback;
}

async function send(id: string): Promise<SendOutcome> {
  try {
    const res = await fetch(`/api/admin/announcements/${id}/dispatch`, { method: "POST" });
    if (res.ok) return { state: "finished", ...(await res.json()) };
    if (res.status < 500) {
      return { state: "refused", reason: await errorReason(res, "The send was refused.") };
    }
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

export async function saveAndSendAnnouncement(
  body: Record<string, unknown>,
  viaTelegram: boolean,
): Promise<SaveAndSendResult> {
  const res = await fetch("/api/admin/announcements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return { saved: false, reason: await errorReason(res, "Failed to send announcement.") };
  }

  const row = (await res.json()) as AnnouncementRow;
  return { saved: true, row, send: viaTelegram ? await send(row.id) : { state: "not_requested" } };
}
