import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/messenger/crypto";
import { verifyOAuthState } from "@/lib/messenger/state";

// ─── GET /api/messenger/callback ────────────────────────────────────────────
// OAuth callback from Meta. The `state` is a signed token (see state.ts) minted
// for the authenticated owner's own tenant at connect time — never a raw slug —
// so the Page can only be bound to the tenant the initiator actually controls.
// Exchanges the code for tokens, saves the encrypted page token, registers the
// webhook.

const GRAPH_API = "https://graph.facebook.com/v19.0";

function settingsUrl(slug: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";
  const { protocol, hostname } = new URL(appUrl);
  return `${protocol}//${slug}.${hostname}/admin/settings`;
}

async function savePage(
  tenantId: string,
  pageId: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();
  const encryptedToken = encryptToken(pageToken);
  const verifyToken = crypto.randomUUID();

  const { error } = await supabase
    .from("tenants")
    .update({
      messenger_page_id: pageId,
      messenger_page_token: encryptedToken,
      messenger_verify_token: verifyToken,
      messenger_enabled: true,
    } as never)
    .eq("id", tenantId);

  if (error) throw new Error(`Failed to save: ${(error as Error).message}`);

  // Subscribe page to webhook events
  const subscribeRes = await fetch(
    `${GRAPH_API}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=${pageToken}`,
    { method: "POST" },
  );
  if (!subscribeRes.ok) {
    console.error("[messenger] Webhook subscription failed:", await subscribeRes.text());
  }
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const stateParam = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  // Verify the signed state first — it identifies the tenant and proves the
  // flow was initiated by that tenant's authenticated owner.
  const state = verifyOAuthState(stateParam);

  if (!state) {
    console.error("[messenger] Invalid or expired OAuth state");
    const errorUrl = new URL(settingsUrl("www"));
    errorUrl.searchParams.set("tab", "messenger");
    errorUrl.searchParams.set("error", "invalid_state");
    return new NextResponse(null, { status: 302, headers: { Location: errorUrl.toString() } });
  }

  const { tenantId, slug } = state;

  // User denied permissions or error occurred
  if (error || !code) {
    console.error("[messenger] OAuth error or missing code:", { error, hasCode: !!code });
    const redirectUrl = new URL(settingsUrl(slug));
    redirectUrl.searchParams.set("tab", "messenger");
    redirectUrl.searchParams.set("error", error ?? "missing_code");
    return new NextResponse(null, { status: 302, headers: { Location: redirectUrl.toString() } });
  }

  const appId = process.env.MESSENGER_APP_ID;
  const appSecret = process.env.MESSENGER_APP_SECRET;

  if (!appId || !appSecret) {
    console.error("[messenger] Missing env vars:", { hasAppId: !!appId, hasAppSecret: !!appSecret });
    const errorUrl = new URL(settingsUrl(slug));
    errorUrl.searchParams.set("tab", "messenger");
    errorUrl.searchParams.set("error", "server_config");
    return new NextResponse(null, { status: 302, headers: { Location: errorUrl.toString() } });
  }
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com"}/api/messenger/callback`;

  try {
    // ── Step 1: Exchange code for short-lived user token ─────────────────
    const tokenUrl = new URL(`${GRAPH_API}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokenRes = await fetch(tokenUrl.toString());
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const { access_token: shortLivedToken } = await tokenRes.json();

    // ── Step 2: Exchange for long-lived user token ──────────────────────
    const longUrl = new URL(`${GRAPH_API}/oauth/access_token`);
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", appId);
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("fb_exchange_token", shortLivedToken);

    const longRes = await fetch(longUrl.toString());
    if (!longRes.ok) throw new Error(`Long-lived token exchange failed: ${longRes.status}`);
    const { access_token: longLivedToken } = await longRes.json();

    // ── Step 3: Get list of pages the user manages ──────────────────────
    const pagesRes = await fetch(`${GRAPH_API}/me/accounts?access_token=${longLivedToken}`);
    if (!pagesRes.ok) throw new Error(`Pages fetch failed: ${pagesRes.status}`);
    const { data: pages } = await pagesRes.json() as {
      data: { id: string; name: string; access_token: string }[];
    };

    if (!pages || pages.length === 0) {
      throw new Error("No Facebook Pages found for this account.");
    }

    // ── Step 4: Single page → auto-connect; multiple → page picker ──────
    if (pages.length === 1) {
      const page = pages[0];
      await savePage(tenantId, page.id, page.access_token);

      const successUrl = new URL(settingsUrl(slug));
      successUrl.searchParams.set("tab", "messenger");
      successUrl.searchParams.set("connected", "true");
      console.log(`[messenger] Auto-connected page ${page.id} (${page.name}) for ${slug}`);
      return new NextResponse(null, { status: 302, headers: { Location: successUrl.toString() } });
    }

    // Multiple pages — store tokens temporarily and redirect to page picker
    const supabase = createAdminClient();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    await supabase.from("messenger_page_sessions").insert(
      pages.map((p) => ({
        session_id: sessionId,
        tenant_slug: slug,
        page_id: p.id,
        page_name: p.name,
        page_token_encrypted: encryptToken(p.access_token),
        expires_at: expiresAt,
      })) as never,
    );

    const pickerUrl = new URL(settingsUrl(slug));
    pickerUrl.searchParams.set("tab", "messenger");
    pickerUrl.searchParams.set("pick_page", sessionId);
    console.log(`[messenger] ${pages.length} pages found for ${slug}, redirecting to picker`);
    return new NextResponse(null, { status: 302, headers: { Location: pickerUrl.toString() } });
  } catch (err) {
    console.error("[messenger] OAuth callback error:", err);
    const errorUrl = new URL(settingsUrl(slug));
    errorUrl.searchParams.set("tab", "messenger");
    errorUrl.searchParams.set("error", "connection_failed");
    return new NextResponse(null, { status: 302, headers: { Location: errorUrl.toString() } });
  }
}
