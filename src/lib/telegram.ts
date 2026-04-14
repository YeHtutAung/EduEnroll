// ─── Telegram message sender ──────────────────────────────────────────────────

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  botToken: string,
): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "unknown");
      console.error(`[telegram] sendMessage failed ${res.status}:`, err);
    }
  } catch (err) {
    console.error("[telegram] sendMessage error:", err);
  }
}
