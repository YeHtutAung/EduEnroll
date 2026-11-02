// Reads the response of GET /api/telegram/settings, where each bot is nested under
// its type. Buyers link to the enrollment bot, so it alone decides the Telegram
// controls. Staff get a 403 body from that route, which reads as not ready.
export function telegramBotIsReady(settings: unknown): boolean {
  const enrollment = (settings as { enrollment?: { connected?: boolean; enabled?: boolean } } | null)
    ?.enrollment;
  return !!(enrollment?.connected && enrollment.enabled);
}
