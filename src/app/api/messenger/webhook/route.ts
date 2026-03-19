import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processMessage } from "@/lib/messenger/processor";
import { decryptToken } from "@/lib/messenger/crypto";
import { verifyMetaSignature } from "@/lib/messenger/verify";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TenantMessenger {
  id: string;
  messenger_page_token: string | null;
}

interface MessagingEvent {
  sender: { id: string };
  message?: {
    text?: string;
    quick_reply?: { payload: string };
  };
}

interface WebhookEntry {
  id: string; // Page ID that received the message
  messaging?: MessagingEvent[];
}

// ─── Resolve tenant from page ID ────────────────────────────────────────────

async function resolveTenantByPageId(pageId: string): Promise<TenantMessenger | null> {
  const supabase = createAdminClient();
  const { data } = (await supabase
    .from("tenants")
    .select("id, messenger_page_token")
    .eq("messenger_page_id", pageId)
    .eq("messenger_enabled", true)
    .limit(1)) as { data: TenantMessenger[] | null; error: unknown };
  return data?.[0] ?? null;
}

// ─── GET /api/messenger/webhook ─────────────────────────────────────────────
// Central webhook verification. Uses a single MESSENGER_VERIFY_TOKEN env var.

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token");
  const challenge = request.nextUrl.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !token || !challenge) {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const verifyToken = process.env.MESSENGER_VERIFY_TOKEN;
  if (!verifyToken) {
    console.error("[messenger] MESSENGER_VERIFY_TOKEN env var is not set");
    return new NextResponse("Server Error", { status: 500 });
  }

  if (token !== verifyToken) {
    console.error("[messenger] Verify token mismatch");
    return new NextResponse("Forbidden", { status: 403 });
  }

  console.log("[messenger] Webhook verified successfully");
  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

// ─── POST /api/messenger/webhook ────────────────────────────────────────────
// Central webhook for ALL schools. Routes by page_id from entry[].id.
// Must respond 200 within 20 seconds.

export async function POST(request: NextRequest) {
  // Verify Meta signature (HMAC-SHA256)
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyMetaSignature(rawBody, signature)) {
    console.warn("[messenger] Invalid signature on central webhook");
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  let body: { entry?: WebhookEntry[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  const entries = body.entry ?? [];
  const promises: Promise<void>[] = [];

  for (const entry of entries) {
    const pageId = entry.id;
    if (!pageId || !entry.messaging?.length) continue;

    // Resolve tenant by page ID
    promises.push(
      (async () => {
        const tenant = await resolveTenantByPageId(pageId);
        if (!tenant || !tenant.messenger_page_token) {
          console.warn(`[messenger] No enabled tenant for page ${pageId}`);
          return;
        }

        let pageToken: string;
        try {
          pageToken = decryptToken(tenant.messenger_page_token);
        } catch {
          console.error(`[messenger] Failed to decrypt token for page ${pageId}`);
          return;
        }

        for (const event of entry.messaging ?? []) {
          if (!event.sender?.id || !event.message) continue;
          await processMessage(
            tenant.id,
            event.sender.id,
            event.message,
            pageToken,
          ).catch((err) => {
            console.error(`[messenger] Error processing message for page ${pageId}:`, err);
          });
        }
      })(),
    );
  }

  await Promise.allSettled(promises);
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
