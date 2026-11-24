import { NextResponse } from "next/server";
import { sendEmail, seatClaimedEmail } from "@/lib/email";
import { maskEmail } from "@/lib/maskEmail";
import { hashShareToken } from "@/server/tickets/shareLinks";
import { limitClaim } from "@/server/tickets/sharingLimits";
import { loadLeaderNotice } from "@/server/tickets/sharingEmail";
import { linkGone, noStore, readClaimRequest, unavailable } from "@/server/tickets/claimRequest";

// ─── POST /api/me/tickets/claim { token } (design 6.4) ──────────────────────
//
// A friend claims a shared seat. claim_share_link decides under the ticket
// lock, from the token's hash, the host's tenant and the session's buyer.
// Every refusal is the one 404. After the claim the leader gets
// seatClaimedEmail with the friend's masked address; a failed send never fails
// the request. Never logs the token or its hash.

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const r = await readClaimRequest(request, limitClaim);
  if (r instanceof NextResponse) return r;
  const { ctx, tenantId, admin, token } = r;

  const { data, error } = await admin.rpc("claim_share_link" as never, {
    p_token_hash: hashShareToken(token),
    p_tenant_id: tenantId,
    p_claimer_id: ctx.buyerId,
  } as never);
  if (error) {
    console.error("[me/tickets/claim] claim failed", (error as { code?: string }).code ?? "");
    return unavailable();
  }
  const row = Array.isArray(data)
    ? (data[0] as { result?: unknown; ticket_id?: unknown; leader_id?: unknown } | undefined)
    : undefined;
  if (row?.result !== "claimed" || typeof row.ticket_id !== "string" || typeof row.leader_id !== "string") {
    return linkGone();
  }

  // The seat has moved: from here on, nothing fails the request.
  const notice = await loadLeaderNotice(admin, { leaderId: row.leader_id, ticketId: row.ticket_id, tenantId }).catch(
    () => null,
  );
  if (notice) {
    const mail = seatClaimedEmail({
      tier: notice.tier,
      claimedBy: maskEmail(ctx.email),
      tenantName: notice.tenantName,
      logoUrl: notice.logoUrl,
    });
    const sent = await sendEmail({ to: notice.to, subject: mail.subject, html: mail.html }).catch(() => false);
    if (!sent) console.error("[me/tickets/claim] email not sent");
  }

  return noStore(NextResponse.json({ ticketId: row.ticket_id }));
}
