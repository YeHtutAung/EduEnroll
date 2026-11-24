import { NextResponse } from "next/server";
import { requireBuyer, resolveTenantId, type BuyerContext } from "@/lib/api";
import { buyerError } from "@/lib/buyers/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/auth/sameOrigin";
import { isShareToken } from "@/server/tickets/shareLinks";
import type { RateLimitResult } from "@/server/buyers/rateLimit";

// The shared front half of POST /api/me/tickets/claim and /claim/preview:
// same-origin, session, tenant, a capped body, the token's shape, then the
// route's limiter. Every link refusal is the one linkGone() 404, so a missing,
// malformed, used or cancelled link all look the same. Never logs the token.

type Admin = ReturnType<typeof createAdminClient>;

const MAX_BODY_BYTES = 1024;

export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const linkGone = () => noStore(buyerError(404, "NOT_FOUND", "This link no longer works."));
export const unavailable = () => noStore(buyerError(503, "SERVER", "Please try again."));

export interface ClaimRequest {
  ctx: BuyerContext;
  tenantId: string;
  admin: Admin;
  token: string;
}

export async function readClaimRequest(
  request: Request,
  limit: (admin: Admin, buyerId: string, headers: Headers) => Promise<RateLimitResult>,
): Promise<ClaimRequest | NextResponse> {
  // Before any Auth call: a sibling tenant subdomain can't act with the buyer's cookie.
  if (!isSameOriginRequest(request)) return noStore(buyerError(403, "FORBIDDEN", "Not allowed."));
  const ctx = await requireBuyer();
  if (ctx instanceof NextResponse) return noStore(ctx);
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return noStore(tenantId);

  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return noStore(buyerError(413, "VALIDATION", "Request body too large."));
  }
  const text = await request.text().catch(() => "");
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return noStore(buyerError(413, "VALIDATION", "Request body too large."));
  }
  let token: unknown;
  try {
    token = (JSON.parse(text) as { token?: unknown } | null)?.token;
  } catch {
    token = undefined;
  }
  if (!isShareToken(token)) return linkGone();

  const admin = createAdminClient();
  const limited = await limit(admin, ctx.buyerId, request.headers);
  if (limited === "limited") return noStore(buyerError(429, "RATE_LIMITED", "Too many attempts. Try again later."));
  if (limited === "unavailable") return unavailable();

  return { ctx, tenantId, admin, token };
}
