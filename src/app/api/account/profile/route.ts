import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireBuyer } from "@/lib/buyers/requireBuyer";
import { acceptToken, readCookieToken } from "@/lib/buyers/sessionUser";
import { buyerError } from "@/lib/buyers/errors";
import { isSameOriginRequest } from "@/lib/auth/sameOrigin";
import { ensureBuyerProfile, type EnsureResult } from "@/server/buyers/ensureBuyerProfile";
import { settleReissue } from "@/server/buyers/reissueSession";

// ─── /api/account/profile: the website's buyer profile ──────────────────────
//
// GET  → requireBuyer(), then { buyerId, email, name, locale }. buyerId keys
//        the phone's device key on /account/tickets/[id].
// POST → the website's "POST /me": cookie session only (Bearer belongs to the
//        app's own route), Auth accepts that exact token, then
//        ensureBuyerProfile claims or creates the profile.
//
// An Auth outage is 503 SERVER, never 401: a 401 signs the buyer out.
// Logs fixed strings only: never a token, a re-issue hash or an email.
//
// First sign-in (Task 11a): ensureBuyerProfile's password reset ends the
// buyer's own session, so it hands back a one-time hash. This route verifies
// it on the cookie client, which writes the new session cookies onto this same
// response. If that fails the profile still exists and the body says
// `reason: "sign_in_again"`; the page asks the buyer to sign in once more.

export const dynamic = "force-dynamic";

const unauthenticated = () => buyerError(401, "UNAUTHENTICATED", "Sign in required.");
const authUnavailable = () => buyerError(503, "SERVER", "Sign-in service unavailable. Try again.");

// The answer is per buyer (it carries buyerId): never cached, errors included.
export async function GET(): Promise<NextResponse> {
  const res = await readProfile();
  res.headers.set("Cache-Control", "no-store");
  return res;
}

async function readProfile(): Promise<NextResponse> {
  const ctx = await requireBuyer();
  if (ctx instanceof NextResponse) return ctx;

  const { data, error } = await createAdminClient()
    .from("buyer_profiles")
    .select("name, locale")
    .eq("id", ctx.buyerId)
    .maybeSingle();
  if (error) {
    console.error("[account/profile] buyer_profiles read failed");
    return buyerError(503, "SERVER", "Try again.");
  }
  // requireBuyer just saw the row; gone now means it was deleted meanwhile.
  if (!data) return unauthenticated();
  const row = data as { name: string | null; locale: "my" | "en" };
  return NextResponse.json({ buyerId: ctx.buyerId, email: ctx.email, name: row.name, locale: row.locale });
}

const MAX_BODY_BYTES = 4096;

type BodyCheck = "ok" | "too_large" | "invalid";

/** Acceptable: empty, or JSON (at most 4 KB) without an `email` key. */
async function checkBody(request: Request): Promise<BodyCheck> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return "too_large";
  let text: string;
  try {
    text = await request.text();
  } catch {
    return "invalid";
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return "too_large";
  if (text.trim() === "") return "ok";
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "email")) {
      return "invalid";
    }
    return "ok";
  } catch {
    return "invalid";
  }
}

async function mapResult(result: EnsureResult): Promise<NextResponse> {
  if (result.ok) {
    const { email, name, locale } = result.profile;
    const body: { email: string; name: string | null; locale: string; reason?: "sign_in_again" } = {
      email,
      name,
      locale,
    };
    if (!(await settleReissue(result.reissue, "account/profile"))) body.reason = "sign_in_again";
    return NextResponse.json(body, { status: result.status });
  }
  switch (result.code) {
    case "FORBIDDEN":
      return NextResponse.json(
        {
          error: {
            code: "FORBIDDEN",
            message:
              result.reason === "staff"
                ? "Staff accounts can't use buyer pages."
                : result.reason === "unconfirmed"
                  ? "Confirm your email with the code we sent, then try again."
                  : "Sign in with the code sent to your email.",
            reason: result.reason,
          },
        },
        { status: 403 },
      );
    case "DELETION_IN_PROGRESS":
      return buyerError(409, "DELETION_IN_PROGRESS", "This account is being deleted.");
    case "SERVER":
    default:
      return buyerError(503, "SERVER", "Try again.");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // Both checks come before any Auth call.
  if (!isSameOriginRequest(request)) return buyerError(403, "FORBIDDEN", "Cross-site request refused.");
  const body = await checkBody(request);
  if (body === "too_large") return buyerError(413, "VALIDATION", "Request body too large.");
  if (body === "invalid") return buyerError(422, "VALIDATION", "Email can't be set here.");

  const read = await readCookieToken();
  if (read.kind === "unavailable") {
    console.error("[account/profile] cookie session read failed");
    return authUnavailable();
  }
  if (read.kind === "none") return unauthenticated();

  const accepted = await acceptToken(read.token);
  if (accepted.kind === "rejected") return unauthenticated();
  if (accepted.kind === "unavailable") {
    console.error("[account/profile] Auth getUser unavailable");
    return authUnavailable();
  }

  // Only now: getUser has accepted this exact token for this user.
  return await mapResult(await ensureBuyerProfile({ user: accepted.user, accessToken: accepted.token }));
}
