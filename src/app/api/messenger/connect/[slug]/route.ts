import { NextRequest, NextResponse } from "next/server";

// ─── GET /api/messenger/connect/[slug] ──────────────────────────────────────
// Redirects to Meta OAuth URL to begin Facebook Page connection.
// The tenant slug is passed as the OAuth state parameter.

export async function GET(
  _request: NextRequest,
  { params }: { params: { slug: string } },
) {
  const appId = process.env.MESSENGER_APP_ID;
  if (!appId) {
    return NextResponse.json(
      { error: "Messenger app not configured." },
      { status: 500 },
    );
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com"}/api/messenger/callback`;
  const scope = "pages_messaging,pages_show_list";
  const state = params.slug;

  const oauthUrl = new URL("https://www.facebook.com/v19.0/dialog/oauth");
  oauthUrl.searchParams.set("client_id", appId);
  oauthUrl.searchParams.set("redirect_uri", redirectUri);
  oauthUrl.searchParams.set("scope", scope);
  oauthUrl.searchParams.set("state", state);
  oauthUrl.searchParams.set("response_type", "code");

  return NextResponse.redirect(oauthUrl.toString());
}
