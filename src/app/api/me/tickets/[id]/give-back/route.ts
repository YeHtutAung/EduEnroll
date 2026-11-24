import { NextResponse } from "next/server";
import { requireBuyer, resolveTenantId } from "@/lib/api";
import { buyerError } from "@/lib/buyers/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/auth/sameOrigin";
import { sendEmail, seatGivenBackEmail } from "@/lib/email";
import { limitGiveBack } from "@/server/tickets/sharingLimits";
import { loadLeaderNotice } from "@/server/tickets/sharingEmail";

// ─── POST /api/me/tickets/[id]/give-back (design 6.4) ───────────────────────
//
// A friend who claimed a seat hands it back to the order's leader.
// give_back_seat decides under the ticket lock, from the host's tenant and the
// session's buyer; no body is read. Every refusal is one 404. After the move,
// the leader gets seatGivenBackEmail; a failed send never fails the request.
// Logs fixed strings and codes only.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const notFound = () => noStore(buyerError(404, "NOT_FOUND", "Seat not available to give back."));
const unavailable = () => noStore(buyerError(503, "SERVER", "Please try again."));

export async function POST(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) return noStore(buyerError(403, "FORBIDDEN", "Not allowed."));
  const ctx = await requireBuyer();
  if (ctx instanceof NextResponse) return noStore(ctx);
  if (!UUID.test(params.id)) return notFound();
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return noStore(tenantId);

  const admin = createAdminClient();
  const limited = await limitGiveBack(admin, ctx.buyerId);
  if (limited === "limited") return noStore(buyerError(429, "RATE_LIMITED", "Too many attempts. Try again later."));
  if (limited === "unavailable") return unavailable();

  const { data, error } = await admin.rpc("give_back_seat" as never, {
    p_ticket_id: params.id,
    p_tenant_id: tenantId,
    p_holder_id: ctx.buyerId,
  } as never);
  if (error) {
    console.error("[me/tickets/give-back] give back failed", (error as { code?: string }).code ?? "");
    return unavailable();
  }
  const row = Array.isArray(data) ? (data[0] as { result?: unknown; leader_id?: unknown } | undefined) : undefined;
  if (row?.result !== "given_back" || typeof row.leader_id !== "string") return notFound();

  // The seat has moved: from here on, nothing fails the request.
  const notice = await loadLeaderNotice(admin, { leaderId: row.leader_id, ticketId: params.id, tenantId }).catch(
    () => null,
  );
  if (notice) {
    const mail = seatGivenBackEmail({ tier: notice.tier, tenantName: notice.tenantName, logoUrl: notice.logoUrl });
    const sent = await sendEmail({ to: notice.to, subject: mail.subject, html: mail.html }).catch(() => false);
    if (!sent) console.error("[me/tickets/give-back] email not sent");
  }

  return noStore(NextResponse.json({ ok: true }));
}
