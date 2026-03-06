import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/messenger/crypto";

// ─── GET /api/messenger/callback ────────────────────────────────────────────
// OAuth callback from Meta. Receives authorization code and state (tenant slug).
// Exchanges for tokens, saves encrypted page token, registers webhook.

const GRAPH_API = "https://graph.facebook.com/v19.0";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state"); // tenant slug
  const error = request.nextUrl.searchParams.get("error");

  // User denied permissions or error occurred
  if (error || !code || !state) {
    const redirectUrl = new URL(`https://${state ?? "www"}.kuunyi.com/admin/settings`);
    redirectUrl.searchParams.set("tab", "messenger");
    redirectUrl.searchParams.set("error", error ?? "missing_code");
    return NextResponse.redirect(redirectUrl.toString());
  }

  const appId = process.env.MESSENGER_APP_ID!;
  const appSecret = process.env.MESSENGER_APP_SECRET!;
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

    // Use the first page (most schools have one page)
    const page = pages[0];
    const pageId = page.id;
    const pageToken = page.access_token; // already long-lived for page tokens

    // ── Step 4: Save encrypted token to tenant ──────────────────────────
    const supabase = createAdminClient();
    const encryptedToken = encryptToken(pageToken);

    // Generate a random verify token for webhook verification
    const verifyToken = crypto.randomUUID();

    const { error: updateError } = await supabase
      .from("tenants")
      .update({
        messenger_page_id: pageId,
        messenger_page_token: encryptedToken,
        messenger_verify_token: verifyToken,
        messenger_enabled: true,
      } as never)
      .eq("subdomain", state);

    if (updateError) throw new Error(`Failed to save: ${(updateError as Error).message}`);

    // ── Step 5: Subscribe the page to webhook events ────────────────────
    const subscribeRes = await fetch(
      `${GRAPH_API}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=${pageToken}`,
      { method: "POST" },
    );
    if (!subscribeRes.ok) {
      console.error("[messenger] Webhook subscription failed:", await subscribeRes.text());
      // Non-fatal: the connection still works, admin can subscribe manually
    }

    // ── Step 6: Redirect back to settings ───────────────────────────────
    const successUrl = new URL(`https://${state}.kuunyi.com/admin/settings`);
    successUrl.searchParams.set("tab", "messenger");
    successUrl.searchParams.set("connected", "true");
    return NextResponse.redirect(successUrl.toString());
  } catch (err) {
    console.error("[messenger] OAuth callback error:", err);
    const errorUrl = new URL(`https://${state}.kuunyi.com/admin/settings`);
    errorUrl.searchParams.set("tab", "messenger");
    errorUrl.searchParams.set("error", "connection_failed");
    return NextResponse.redirect(errorUrl.toString());
  }
}
