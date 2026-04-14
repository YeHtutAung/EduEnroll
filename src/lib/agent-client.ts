// ─── AI agent client (Google ADK) ────────────────────────────────────────────
// POSTs to an external ADK agent service at AGENT_API_URL.
//
// Request:  POST /run  { appName, userId, sessionId, newMessage }
// Response: Event[]    — array of ADK events; reply is in the last model event

interface AdkPart {
  text?: string;
}

interface AdkContent {
  parts?: AdkPart[] | null;
  role?: string | null;
}

interface AdkEvent {
  author: string;
  content?: AdkContent | null;
  turnComplete?: boolean | null;
}

export async function askAgent(
  message: string,
  sessionId: string,
  tenantSlug: string,
): Promise<string> {
  const baseUrl = process.env.AGENT_API_URL;
  if (!baseUrl) throw new Error("AGENT_API_URL is not set");

  const appName = process.env.AGENT_APP_NAME ?? tenantSlug;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appName,
        userId: sessionId,
        sessionId,
        newMessage: {
          parts: [{ text: message }],
          role: "user",
        },
      }),
    });
  } catch {
    return "Sorry, I'm having trouble connecting to the agent. Please try again.";
  }

  if (!res.ok) {
    return "Sorry, I'm having trouble connecting to the agent. Please try again.";
  }

  const events = (await res.json().catch(() => null)) as AdkEvent[] | null;
  if (!Array.isArray(events)) {
    return "Sorry, I'm having trouble connecting to the agent. Please try again.";
  }

  // Find the last model event that has text content
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== "user" && event.content?.parts) {
      const text = event.content.parts
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      if (text) return text;
    }
  }

  return "Sorry, I'm having trouble connecting to the agent. Please try again.";
}
