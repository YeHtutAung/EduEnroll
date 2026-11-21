import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireBuyer } from "@/lib/buyers/requireBuyer";
import { acceptToken, readCookieToken } from "@/lib/buyers/sessionUser";
import { buyerError } from "@/lib/buyers/errors";
import { ensureBuyerProfile, type EnsureResult } from "@/server/buyers/ensureBuyerProfile";

// ─── /api/account/profile: the website's buyer profile ──────────────────────
//
// GET  → requireBuyer(), then { email, name, locale }.
// POST → the website's "POST /me": cookie session only (Bearer belongs to the
//        app's own route), Auth accepts that exact token, then
//        ensureBuyerProfile claims or creates the profile.
//
// An Auth outage is 503 SERVER, never 401: a 401 signs the buyer out.
// Logs fixed strings only: never a token or an email.

export const dynamic = "force-dynamic";

const unauthenticated = () => buyerError(401, "UNAUTHENTICATED", "Sign in required.");
const authUnavailable = () => buyerError(503, "SERVER", "Sign-in service unavailable. Try again.");

export async function GET(): Promise<NextResponse> {
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
  return NextResponse.json({ email: ctx.email, name: row.name, locale: row.locale });
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

/**
 * CSRF hardening: the cookie rides along on cross-site requests, so refuse a
 * browser request that isn't same-origin. sec-fetch-site cross-site or
 * same-site, or an Origin whose host isn't this request's Host, is refused.
 * With neither header (not a browser) it's allowed: the cookie is still needed.
 */
function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const host = request.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  return !host || originHost.toLowerCase() !== host.toLowerCase();
}

function mapResult(result: EnsureResult): NextResponse {
  if (result.ok) {
    const { email, name, locale } = result.profile;
    return NextResponse.json({ email, name, locale }, { status: result.status });
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
  if (isCrossSite(request)) return buyerError(403, "FORBIDDEN", "Cross-site request refused.");
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
  return mapResult(await ensureBuyerProfile({ user: accepted.user, accessToken: accepted.token }));
}
