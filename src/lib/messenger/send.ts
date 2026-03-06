// ─── Messenger Send API helper ──────────────────────────────────────────────

const GRAPH_API = "https://graph.facebook.com/v19.0";

interface QuickReply {
  content_type: "text";
  title: string;
  payload: string;
}

export async function sendTextMessage(
  pageToken: string,
  recipientPsid: string,
  text: string,
): Promise<void> {
  await fetch(`${GRAPH_API}/me/messages?access_token=${pageToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      message: { text },
    }),
  });
}

export async function sendQuickReplies(
  pageToken: string,
  recipientPsid: string,
  text: string,
  quickReplies: QuickReply[],
): Promise<void> {
  await fetch(`${GRAPH_API}/me/messages?access_token=${pageToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      message: { text, quick_replies: quickReplies },
    }),
  });
}
