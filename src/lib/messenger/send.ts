// ─── Messenger Send API helper ──────────────────────────────────────────────

const GRAPH_API = "https://graph.facebook.com/v19.0";

interface QuickReply {
  content_type: "text";
  title: string;
  payload: string;
}

async function callSendAPI(
  pageToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${GRAPH_API}/me/messages?access_token=${pageToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "unknown");
    console.error(`[messenger] Send API error ${res.status}:`, errorBody);
  }
}

export async function sendTextMessage(
  pageToken: string,
  recipientPsid: string,
  text: string,
): Promise<void> {
  await callSendAPI(pageToken, {
    recipient: { id: recipientPsid },
    message: { text },
  });
}

export async function sendQuickReplies(
  pageToken: string,
  recipientPsid: string,
  text: string,
  quickReplies: QuickReply[],
): Promise<void> {
  await callSendAPI(pageToken, {
    recipient: { id: recipientPsid },
    message: { text, quick_replies: quickReplies },
  });
}

interface UrlButton {
  type: "web_url";
  url: string;
  title: string;
}

export async function sendButtonTemplate(
  pageToken: string,
  recipientPsid: string,
  text: string,
  buttons: UrlButton[],
): Promise<void> {
  await callSendAPI(pageToken, {
    recipient: { id: recipientPsid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text,
          buttons,
        },
      },
    },
  });
}
