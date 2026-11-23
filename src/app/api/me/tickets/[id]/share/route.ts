import { NextResponse } from "next/server";
import { requireBuyer, resolveTenantId, type BuyerContext } from "@/lib/api";
import { buyerError } from "@/lib/buyers/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/auth/sameOrigin";
import { tenantLinkOrigin } from "@/lib/origin";
import { hashShareToken, newShareToken, shareLinkUrl } from "@/server/tickets/shareLinks";
import { limitShare } from "@/server/tickets/sharingLimits";

// ─── POST/DELETE /api/me/tickets/[id]/share (design 6.4) ────────────────────
//
// POST makes a new share link for one seat, replacing any open one; DELETE
// cancels the open link. Only the leader of the order can do either, which
// create_share_link / cancel_share_link decide under the ticket lock from the
// host's tenant and the session's buyer. Neither method reads a body.
//
// The token exists only in the answer's url fragment: never in a log line,
// an error or a header. The database gets its SHA-256. Every refusal is one 404.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const notAvailable = () => noStore(buyerError(404, "NOT_FOUND", "Seat not available to share."));
const unavailable = () => noStore(buyerError(503, "SERVER", "Please try again."));

type Admin = ReturnType<typeof createAdminClient>;
type Guarded = { ctx: BuyerContext; tenantId: string; admin: Admin };

/** Same-origin, session, id, tenant and the share limit: in that order, before any RPC. */
async function guard(request: Request, id: string): Promise<Guarded | NextResponse> {
  // Before any Auth call: a sibling tenant subdomain can't act with the buyer's cookie.
  if (!isSameOriginRequest(request)) return noStore(buyerError(403, "FORBIDDEN", "Not allowed."));
  const ctx = await requireBuyer();
  if (ctx instanceof NextResponse) return noStore(ctx);
  if (!UUID.test(id)) return notAvailable();
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return noStore(tenantId);

  const admin = createAdminClient();
  const limited = await limitShare(admin, ctx.buyerId);
  if (limited === "limited") return noStore(buyerError(429, "RATE_LIMITED", "Too many attempts. Try again later."));
  if (limited === "unavailable") return unavailable();
  return { ctx, tenantId, admin };
}

export async function POST(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const g = await guard(request, params.id);
  if (g instanceof NextResponse) return g;
  const { ctx, tenantId, admin } = g;

  const { data: tenant, error: tenantError } = (await admin
    .from("tenants")
    .select("subdomain")
    .eq("id", tenantId)
    .maybeSingle()) as unknown as { data: { subdomain: string | null } | null; error: { code?: string } | null };
  if (tenantError || !tenant) {
    console.error("[me/tickets/share] tenant read failed", tenantError?.code ?? "");
    return unavailable();
  }

  const token = newShareToken();
  const { data, error } = await admin.rpc("create_share_link" as never, {
    p_ticket_id: params.id,
    p_tenant_id: tenantId,
    p_leader_id: ctx.buyerId,
    p_token_hash: hashShareToken(token),
  } as never);
  if (error) {
    console.error("[me/tickets/share] create failed", (error as { code?: string }).code ?? "");
    return unavailable();
  }
  const row = Array.isArray(data) ? (data[0] as { result?: unknown; expires_at?: unknown } | undefined) : undefined;
  // 'refused' (including a duplicate hash), or anything unexpected.
  if (row?.result !== "created" || typeof row.expires_at !== "string") return notAvailable();

  return noStore(
    NextResponse.json({ url: shareLinkUrl(tenantLinkOrigin(tenant.subdomain), token), expiresAt: row.expires_at }),
  );
}

export async function DELETE(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const g = await guard(request, params.id);
  if (g instanceof NextResponse) return g;
  const { ctx, tenantId, admin } = g;

  const { data, error } = await admin.rpc("cancel_share_link" as never, {
    p_ticket_id: params.id,
    p_tenant_id: tenantId,
    p_leader_id: ctx.buyerId,
  } as never);
  if (error) {
    console.error("[me/tickets/share] cancel failed", (error as { code?: string }).code ?? "");
    return unavailable();
  }
  if (data === "cancelled") return noStore(NextResponse.json({ cancelled: true }));
  if (data === "none") return noStore(NextResponse.json({ cancelled: false }));
  return notAvailable();
}
