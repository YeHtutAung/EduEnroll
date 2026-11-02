// ─── Enrollment bot token ───────────────────────────────────────────────────
// Buyers link to the enrollment bot, so a chat id on an enrollment is only
// reachable through it. A support bot has never spoken to them.

import type { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "./crypto";
import { decryptToken as decryptLegacyToken } from "@/lib/messenger/crypto";

export type EnrollmentBotToken =
  | { status: "ready"; botToken: string }
  // No bot, a disabled bot, or a bot with no token. Normal, so not logged.
  | { status: "unavailable" }
  // The read or the decryption failed. Already logged.
  | { status: "failed" };

// tenant_bots holds two formats. Rows carried over by migration 071 were written
// with the Messenger helper (base64, no colons), later ones with the Telegram
// helper (iv:authTag:ciphertext).
export function decryptBotToken(stored: string): string {
  return stored.includes(":") ? decryptToken(stored) : decryptLegacyToken(stored);
}

export async function getEnrollmentBotToken(
  supabase: ReturnType<typeof createAdminClient>,
  tenantId: string,
  logPrefix: string,
): Promise<EnrollmentBotToken> {
  // A tenant without one is normal, hence maybeSingle.
  const { data: bot, error } = (await supabase
    .from("tenant_bots")
    .select("bot_token, enabled")
    .eq("tenant_id", tenantId)
    .eq("bot_type", "enrollment")
    .maybeSingle()) as {
    data: { bot_token: string | null; enabled: boolean } | null;
    error: unknown;
  };

  if (error) {
    console.error(`[${logPrefix}] enrollment bot lookup failed for`, tenantId, error);
    return { status: "failed" };
  }

  if (!bot?.enabled || !bot.bot_token) return { status: "unavailable" };

  try {
    return { status: "ready", botToken: decryptBotToken(bot.bot_token) };
  } catch (err) {
    console.error(
      `[${logPrefix}] failed to decrypt enrollment bot token for`,
      tenantId,
      err instanceof Error ? err.message : "unknown error",
    );
    return { status: "failed" };
  }
}
