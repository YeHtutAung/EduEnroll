import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAuth } from "@/lib/api";
import { decryptToken, encryptToken } from "@/lib/messenger/crypto";

const GRAPH_API = "https://graph.facebook.com/v19.0";

// ─── GET /api/messenger/select-page?session=<id> ─────────────────────────────
// Returns the list of pages for a given session (for the page picker UI).

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const sessionId = request.nextUrl.searchParams.get("session");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: rows } = (await supabase
    .from("messenger_page_sessions")
    .select("page_id, page_name")
    .eq("session_id", sessionId)
    .gt("expires_at", new Date().toISOString())) as {
    data: { page_id: string; page_name: string }[] | null;
    error: unknown;
  };

  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: "Session expired or not found" }, { status: 404 });
  }

  return NextResponse.json({ pages: rows });
}

// ─── POST /api/messenger/select-page ─────────────────────────────────────────
// Selects a page from the session and saves it to the tenant.

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const { session_id, page_id } = await request.json();
  if (!session_id || !page_id) {
    return NextResponse.json({ error: "Missing session_id or page_id" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Find the selected page in the session
  const { data: row } = (await supabase
    .from("messenger_page_sessions")
    .select("tenant_slug, page_id, page_name, page_token_encrypted")
    .eq("session_id", session_id)
    .eq("page_id", page_id)
    .gt("expires_at", new Date().toISOString())
    .single()) as {
    data: {
      tenant_slug: string;
      page_id: string;
      page_name: string;
      page_token_encrypted: string;
    } | null;
    error: unknown;
  };

  if (!row) {
    return NextResponse.json({ error: "Session expired or page not found" }, { status: 404 });
  }

  // Decrypt and re-encrypt (token is already encrypted from callback)
  const pageToken = decryptToken(row.page_token_encrypted);
  const encryptedToken = encryptToken(pageToken);
  const verifyToken = crypto.randomUUID();

  // Save to tenant
  const { error: updateError } = await supabase
    .from("tenants")
    .update({
      messenger_page_id: row.page_id,
      messenger_page_token: encryptedToken,
      messenger_verify_token: verifyToken,
      messenger_enabled: true,
    } as never)
    .eq("subdomain", row.tenant_slug);

  if (updateError) {
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  // Subscribe page to webhook events
  const subscribeRes = await fetch(
    `${GRAPH_API}/${row.page_id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=${pageToken}`,
    { method: "POST" },
  );
  if (!subscribeRes.ok) {
    console.error("[messenger] Webhook subscription failed:", await subscribeRes.text());
  }

  // Clean up session
  await supabase.from("messenger_page_sessions").delete().eq("session_id", session_id);

  console.log(`[messenger] Selected page ${row.page_id} (${row.page_name}) for ${row.tenant_slug}`);
  return NextResponse.json({ ok: true, pageId: row.page_id, pageName: row.page_name });
}
