import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { acceptToken } from "@/lib/buyers/sessionUser";
import { safeNext, DEFAULT_NEXT } from "@/lib/auth/safeNext";
import { ensureBuyerProfile, type EnsureResult } from "@/server/buyers/ensureBuyerProfile";
import { settleReissue } from "@/server/buyers/reissueSession";

// ─── GET /auth/callback: where Google sends the buyer back (PKCE) ───────────
//
// /account starts signInWithOAuth on the browser client, which keeps the PKCE
// verifier in a cookie on this host. Here the cookie server client exchanges
// the code for a session, Auth accepts that exact token (getUser), and
// ensureBuyerProfile claims or creates the profile, as POST
// /api/account/profile does for an email code.
//
// Cookies: the server client writes through next/headers cookies(). In a route
// handler Next merges those writes onto the response the handler returns, the
// redirect included, so the session from the exchange, a re-issued session
// (after the first-sign-in password reset), or a local sign-out all reach the
// browser on this one 303.
//
// Every answer is a 303 with Cache-Control: no-store, to this request's own
// origin (request.url, never a forwarded-host header), to `next` only after
// safeNext(). Logs fixed strings only: never the code, a token, the re-issue
// hash or the email.

export const dynamic = "force-dynamic";

const LOG = "auth/callback";

type Notice = "google_failed" | "staff" | "deleting" | "sign_in_again" | "retry_profile";

function redirect(request: Request, path: string): NextResponse {
  const origin = new URL(request.url).origin;
  let target = new URL(path, origin);
  // safeNext already guarantees this; a cross-origin target is never sent.
  if (target.origin !== origin) target = new URL(DEFAULT_NEXT, origin);
  const res = NextResponse.redirect(target, 303);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const withNotice = (request: Request, notice: Notice) => redirect(request, `${DEFAULT_NEXT}?notice=${notice}`);

type Client = ReturnType<typeof createClient>;

/** Drop this browser's session cookies. Never throws. */
async function signOutLocal(supabase: Client): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    console.error(`[${LOG}] local sign-out failed`);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const next = safeNext(params.get("next"));

  // No code: the buyer cancelled at Google, or Google/Auth sent an error.
  if (!code) return withNotice(request, "google_failed");

  const supabase = createClient();

  let accessToken: string | undefined;
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    accessToken = error ? undefined : data?.session?.access_token;
  } catch {
    accessToken = undefined;
  }
  if (!accessToken) {
    console.error(`[${LOG}] code exchange failed`);
    return withNotice(request, "google_failed");
  }

  // The same rule as the profile route: Auth must accept this exact token.
  const accepted = await acceptToken(accessToken);
  if (accepted.kind === "rejected") {
    await signOutLocal(supabase);
    return withNotice(request, "google_failed");
  }
  if (accepted.kind === "unavailable") {
    // Keep the session: /account retries the profile POST.
    console.error(`[${LOG}] Auth getUser unavailable`);
    return withNotice(request, "retry_profile");
  }

  let result: EnsureResult;
  try {
    result = await ensureBuyerProfile({ user: accepted.user, accessToken: accepted.token });
  } catch {
    console.error(`[${LOG}] ensureBuyerProfile failed`);
    result = { ok: false, status: 503, code: "SERVER" };
  }

  if (result.ok) {
    // 201 (and a 200 that ran the reset): the reset ended the session this
    // exchange made; re-issue it onto this response's cookies.
    if (!(await settleReissue(result.reissue, LOG))) {
      await signOutLocal(supabase);
      return withNotice(request, "sign_in_again");
    }
    return redirect(request, next);
  }

  switch (result.code) {
    case "FORBIDDEN":
      await signOutLocal(supabase);
      return withNotice(request, result.reason === "staff" ? "staff" : "google_failed");
    case "DELETION_IN_PROGRESS":
      await signOutLocal(supabase);
      return withNotice(request, "deleting");
    case "SERVER":
    default:
      // Keep the session: /account retries the profile POST.
      return withNotice(request, "retry_profile");
  }
}
