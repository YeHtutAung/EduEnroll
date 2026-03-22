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

// ─── Channel management helpers (Sprint 9) ──────────────────────────────────

/** Send a "Share Phone Number" keyboard button to the user */
export async function requestContact(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [[{ text: "📱 Share Phone Number", request_contact: true }]],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    console.error(`[telegram] requestContact error ${res.status}:`, err);
  }
}

/** Remove custom keyboard (replace with default) */
export async function removeKeyboard(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { remove_keyboard: true },
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    console.error(`[telegram] removeKeyboard error ${res.status}:`, err);
  }
}

/** Get chat info (title, type, etc.) */
export async function getChat(
  botToken: string,
  chatId: string,
): Promise<{ ok: boolean; result?: { id: number; title?: string; type: string } }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getChat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId }),
  });
  return res.json();
}

/** Check if a user is a member/admin of a chat */
export async function getChatMember(
  botToken: string,
  chatId: string,
  userId: number,
): Promise<{
  ok: boolean;
  result?: { status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked" };
}> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getChatMember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, user_id: userId }),
  });
  return res.json();
}

/** Get member count of a chat/channel */
export async function getChatMemberCount(
  botToken: string,
  chatId: string,
): Promise<{ ok: boolean; result?: number }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getChatMemberCount`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId }),
  });
  return res.json();
}

/** Create an invite link for a channel (with optional join-request approval) */
export async function createChatInviteLink(
  botToken: string,
  chatId: string,
  options?: { creates_join_request?: boolean; name?: string },
): Promise<{ ok: boolean; result?: { invite_link: string } }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/createChatInviteLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      creates_join_request: options?.creates_join_request ?? true,
      name: options?.name,
    }),
  });
  return res.json();
}

/** Approve a chat join request */
export async function approveChatJoinRequest(
  botToken: string,
  chatId: string | number,
  userId: number,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/approveChatJoinRequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, user_id: userId }),
  });
  return res.json();
}

/** Decline a chat join request */
export async function declineChatJoinRequest(
  botToken: string,
  chatId: string | number,
  userId: number,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/declineChatJoinRequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, user_id: userId }),
  });
  return res.json();
}
