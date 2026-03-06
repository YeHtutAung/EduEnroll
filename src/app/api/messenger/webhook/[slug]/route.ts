import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processMessage } from "@/lib/messenger/processor";
import { decryptToken } from "@/lib/messenger/crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TenantMessenger {
  id: string;
  messenger_enabled: boolean;
  messenger_page_token: string | null;
  messenger_verify_token: string | null;
}

type TenantResult = { data: TenantMessenger | null; error: unknown };

interface MessagingEvent {
  sender: { id: string };
  message?: {
    text?: string;
    quick_reply?: { payload: string };
  };
}

interface WebhookEntry {
  messaging?: MessagingEvent[];
}

// ─── Resolve tenant from slug ───────────────────────────────────────────────

async function resolveTenant(slug: string): Promise<TenantMessenger | null> {
  const supabase = createAdminClient();
  const { data } = (await supabase
    .from("tenants")
    .select("id, messenger_enabled, messenger_page_token, messenger_verify_token")
    .eq("subdomain", slug)
    .single()) as TenantResult;
  return data;
}

// ─── GET /api/messenger/webhook/[slug] ──────────────────────────────────────
// Meta webhook verification. Called once when setting up the webhook in
// Meta Developer Console. Checks hub.verify_token against tenant config.

export async function GET(
  request: NextRequest,
  { params }: { params: { slug: string } },
) {
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token");
  const challenge = request.nextUrl.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !token || !challenge) {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const tenant = await resolveTenant(params.slug);

  if (!tenant || !tenant.messenger_enabled || token !== tenant.messenger_verify_token) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Return the challenge as plain text (Meta expects this exact format)
  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

// ─── POST /api/messenger/webhook/[slug] ─────────────────────────────────────
// Receive webhook events from Meta. Must respond 200 within 20 seconds.
// Processing is done synchronously but kept fast (single DB query per message).

export async function POST(
  request: NextRequest,
  { params }: { params: { slug: string } },
) {
  const tenant = await resolveTenant(params.slug);

  if (!tenant || !tenant.messenger_enabled || !tenant.messenger_page_token) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  // Decrypt the stored page token
  let pageToken: string;
  try {
    pageToken = decryptToken(tenant.messenger_page_token);
  } catch {
    console.error(`[messenger] Failed to decrypt page token for ${params.slug}`);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  let body: { entry?: WebhookEntry[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  const entries = body.entry ?? [];

  // Process all messaging events (fire-and-forget style but awaited)
  const promises: Promise<void>[] = [];

  for (const entry of entries) {
    for (const event of entry.messaging ?? []) {
      if (!event.sender?.id || !event.message) continue;

      promises.push(
        processMessage(
          tenant.id,
          event.sender.id,
          event.message,
          pageToken,
        ).catch((err) => {
          console.error(`[messenger] Error processing message for ${params.slug}:`, err);
        }),
      );
    }
  }

  // Await all but don't let individual failures break the response
  await Promise.allSettled(promises);

  // Always return 200 — Meta will retry on non-200 responses
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
