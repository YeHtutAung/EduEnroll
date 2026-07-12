import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { signOAuthState } from "@/lib/messenger/state";

// ─── GET /api/messenger/connect/[slug] ──────────────────────────────────────
// Begins the Meta OAuth Page-connection flow. The tenant is taken from the
// authenticated owner's session (NOT the [slug] path param, which is untrusted)
// and carried to the callback as a short-lived, HMAC-signed `state` token. This
// prevents an attacker from binding their own Facebook Page to another tenant.

export async function GET() {
  const appId = process.env.MESSENGER_APP_ID;
  if (!appId) {
    console.error("[messenger] MESSENGER_APP_ID is not set in environment variables");
    return NextResponse.json(
      {
        error: "Messenger app not configured.",
        detail: "MESSENGER_APP_ID environment variable is missing. Add it in the Vercel dashboard.",
      },
      { status: 500 },
    );
  }

  // Only an authenticated owner may connect a Page — and only for their own tenant.
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;

  const { data: tenant } = (await auth.supabase
    .from("tenants")
    .select("subdomain")
    .eq("id", auth.tenantId)
    .single()) as { data: { subdomain: string } | null; error: unknown };

  if (!tenant?.subdomain) {
    return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";
  const redirectUri = `${appUrl}/api/messenger/callback`;
  const scope = "pages_messaging,pages_show_list,pages_manage_metadata";
  const state = signOAuthState(auth.tenantId, tenant.subdomain);

  const oauthUrl = new URL("https://www.facebook.com/v19.0/dialog/oauth");
  oauthUrl.searchParams.set("client_id", appId);
  oauthUrl.searchParams.set("redirect_uri", redirectUri);
  oauthUrl.searchParams.set("scope", scope);
  oauthUrl.searchParams.set("state", state);
  oauthUrl.searchParams.set("response_type", "code");

  console.log(`[messenger] Redirecting ${tenant.subdomain} to Meta OAuth`);

  // Explicit 302 redirect with Location header for maximum compatibility.
  return new NextResponse(null, {
    status: 302,
    headers: { Location: oauthUrl.toString() },
  });
}
