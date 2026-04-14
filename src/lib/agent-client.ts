// ─── AI agent client ─────────────────────────────────────────────────────────
// POSTs to an external agent service at AGENT_API_URL.

export async function askAgent(
  message: string,
  sessionId: string,
  tenantSlug: string,
): Promise<string> {
  const baseUrl = process.env.AGENT_API_URL;
  if (!baseUrl) throw new Error("AGENT_API_URL is not set");

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, session_id: sessionId, tenant_slug: tenantSlug }),
    });
  } catch {
    return "Sorry, I'm having trouble connecting to the agent. Please try again.";
  }

  if (!res.ok) {
    return "Sorry, I'm having trouble connecting to the agent. Please try again.";
  }

  const data = (await res.json().catch(() => null)) as { reply?: string } | null;
  return data?.reply ?? "Sorry, I'm having trouble connecting to the agent. Please try again.";
}
