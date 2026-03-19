// ─── Telegram Bot API helper ─────────────────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org";

export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML",
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    console.error(`[telegram] sendMessage error ${res.status}:`, err);
  }
}

export async function sendMessageWithButtons(
  botToken: string,
  chatId: string,
  text: string,
  buttons: { text: string; url: string }[][],
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buttons.map((row) =>
          row.map((btn) => ({ text: btn.text, url: btn.url })),
        ),
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    console.error(`[telegram] sendMessageWithButtons error ${res.status}:`, err);
  }
}

// ─── Admin API helpers ──────────────────────────────────────────────────────

export async function getMe(botToken: string): Promise<{ ok: boolean; result?: { username: string } }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getMe`);
  return res.json();
}

export async function setWebhook(
  botToken: string,
  url: string,
  secretToken?: string,
): Promise<{ ok: boolean; description?: string }> {
  const body: Record<string, string> = { url };
  if (secretToken) body.secret_token = secretToken;

  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function deleteWebhook(botToken: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/deleteWebhook`, {
    method: "POST",
  });
  return res.json();
}
