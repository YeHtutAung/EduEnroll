// ─── AI agent client (Google ADK) ────────────────────────────────────────────
// Talks to an external ADK agent service at AGENT_API_URL.
//
// ADK requires a session to exist before /run — this client ensures the session
// is created (idempotent: ignores 409 if it already exists) then runs the agent.

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

const FALLBACK = "Sorry, I'm having trouble connecting to the agent. Please try again.";

async function ensureSession(baseUrl: string, appName: string, userId: string, sessionId: string): Promise<void> {
  const res = await fetch(
    `${baseUrl}/apps/${appName}/users/${userId}/sessions/${sessionId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  // 200 = created, 409 = already exists — both are fine
  if (!res.ok && res.status !== 409) {
    throw new Error(`Failed to create session: ${res.status}`);
  }
}

export async function askAgent(
  message: string,
  sessionId: string,
  tenantSlug: string,
): Promise<string> {
  const baseUrl = process.env.AGENT_API_URL;
  if (!baseUrl) throw new Error("AGENT_API_URL is not set");

  const appName = process.env.AGENT_APP_NAME ?? tenantSlug;
  const userId = sessionId; // use chatId as both userId and sessionId for persistent memory

  try {
    await ensureSession(baseUrl, appName, userId, sessionId);
  } catch {
    return FALLBACK;
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appName,
        userId,
        sessionId,
        newMessage: {
          parts: [{ text: message }],
          role: "user",
        },
      }),
    });
  } catch {
    return FALLBACK;
  }

  if (!res.ok) return FALLBACK;

  const events = (await res.json().catch(() => null)) as AdkEvent[] | null;
  if (!Array.isArray(events)) return FALLBACK;

  // Find the last non-user event with text content
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

  return FALLBACK;
}
