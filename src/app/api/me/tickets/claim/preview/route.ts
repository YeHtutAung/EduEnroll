import { NextResponse } from "next/server";
import { hashShareToken } from "@/server/tickets/shareLinks";
import { limitPreview } from "@/server/tickets/sharingLimits";
import { linkGone, noStore, readClaimRequest, unavailable } from "@/server/tickets/claimRequest";

// ─── POST /api/me/tickets/claim/preview { token } (plan 4 decision 4) ───────
//
// What /t/claim shows before "Claim this seat": event, tier, seat and date.
// preview_share_link applies the claim's checks without locks and changes
// nothing; the claim stays the authority. Same refusals and the same 404 as
// the claim, with its own per-buyer limit and the claim's per-IP one
// (decision 12). Never logs the token or its hash.

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const r = await readClaimRequest(request, limitPreview);
  if (r instanceof NextResponse) return r;
  const { ctx, tenantId, admin, token } = r;

  const { data, error } = await admin.rpc("preview_share_link" as never, {
    p_token_hash: hashShareToken(token),
    p_tenant_id: tenantId,
    p_claimer_id: ctx.buyerId,
  } as never);
  if (error) {
    console.error("[me/tickets/claim/preview] preview failed", (error as { code?: string }).code ?? "");
    return unavailable();
  }
  const row = Array.isArray(data)
    ? (data[0] as { event_name?: unknown; tier?: unknown; seat_no?: unknown; event_date?: unknown } | undefined)
    : undefined;
  if (!row || typeof row.tier !== "string" || typeof row.seat_no !== "number") return linkGone();

  return noStore(
    NextResponse.json({
      eventName: typeof row.event_name === "string" ? row.event_name : "Event",
      tier: row.tier,
      seatNo: row.seat_no,
      eventDate: typeof row.event_date === "string" ? row.event_date : null,
    }),
  );
}
