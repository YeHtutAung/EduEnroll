import { NextResponse } from "next/server";
import { createPublicKey } from "crypto";
import { requireBuyer, resolveTenantId } from "@/lib/api";
import { buyerError } from "@/lib/buyers/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { consumeRateLimit } from "@/server/buyers/rateLimit";
import { signBoundTicket } from "@/lib/tickets/sign";
import { loadSigningKey } from "@/lib/tickets/keys";
import { sendEmail, ticketNewPhoneEmail } from "@/lib/email";
import { isSameOriginRequest } from "@/lib/auth/sameOrigin";

// ─── POST /api/me/tickets/[id]/device: bind this phone (design 6.1) ─────────
//
// The signed-in buyer sends the public half of the phone's non-extractable
// P-256 key. bind_ticket_device locks the ticket, checks the buyer, revokes
// the previous phone and records this one; the answer is a bound token
// carrying `dk`. Every refusal looks the same: "not your ticket", "no such
// ticket" and a deleted profile are one 404.
//
// Never logs a token, a device key or an email: fixed strings and codes only.

export const dynamic = "force-dynamic";

const DK = /^[A-Za-z0-9_-]{87}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Abuse protection only (design 2, 6.1: no bind limit for real use). Counts key changes. */
const BIND_LIMIT = { windowSeconds: 3600, limit: 30 };
/** One new-phone email per buyer per 10-minute fixed window, not one per seat. */
const MAIL_WINDOW_SECONDS = 600;
const BOUND = new Set(["bound_first", "bound_again", "unchanged"]);
const MAX_BODY_BYTES = 2048;

/**
 * A raw uncompressed P-256 point in canonical base64url: 87 chars, 65 bytes
 * starting 0x04, on the curve, and re-encoding to exactly the posted string
 * (the last char carries 2 unused bits, so a flipped one decodes the same).
 */
function isCanonicalP256Point(dk: string): boolean {
  if (!DK.test(dk)) return false;
  const raw = Buffer.from(dk, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  if (raw.toString("base64url") !== dk) return false;
  try {
    createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    return true;
  } catch {
    return false;
  }
}

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const notFound = () => noStore(buyerError(404, "NOT_FOUND", "Ticket not found."));
const unavailable = () => noStore(buyerError(503, "SERVER", "Please try again."));

interface TicketRow {
  id: string;
  intake_id: string;
  tier: string;
  admits: number;
  exp: string;
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  // Before any Auth call: a sibling tenant subdomain can't bind with the buyer's cookie.
  if (!isSameOriginRequest(request)) return noStore(buyerError(403, "FORBIDDEN", "Not allowed."));
  const ctx = await requireBuyer();
  if (ctx instanceof NextResponse) return noStore(ctx);
  if (!UUID.test(params.id)) return notFound();
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return noStore(tenantId);

  // The body is one 87-char key; cap it like the profile route caps its body.
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return noStore(buyerError(413, "VALIDATION", "Request body too large."));
  }
  const text = await request.text().catch(() => "");
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return noStore(buyerError(413, "VALIDATION", "Request body too large."));
  }
  let publicKey: unknown;
  try {
    publicKey = (JSON.parse(text) as { publicKey?: unknown } | null)?.publicKey;
  } catch {
    publicKey = undefined;
  }
  if (typeof publicKey !== "string" || !isCanonicalP256Point(publicKey)) {
    return noStore(buyerError(400, "VALIDATION", "A device key is required."));
  }

  // The bind revokes the previous phone, so make sure a token can be signed
  // BEFORE binding: a broken key must not leave the buyer with no working phone.
  try {
    loadSigningKey();
  } catch {
    console.error("[me/tickets/device] ticket signing key unavailable");
    return unavailable();
  }

  const admin = createAdminClient();

  // Count only key changes: a reload re-sending this buyer's bound key is free.
  // Scoped to the buyer, so a key seen in someone else's QR doesn't skip the limit.
  const { data: active, error: activeError } = (await admin
    .from("ticket_devices")
    .select("public_key")
    .eq("ticket_id", params.id)
    .eq("buyer_id", ctx.buyerId)
    .is("revoked_at", null)
    .maybeSingle()) as unknown as { data: { public_key: string } | null; error: unknown };
  if (activeError) {
    console.error("[me/tickets/device] active key read failed");
    return unavailable();
  }
  if (active?.public_key !== publicKey) {
    const limited = await consumeRateLimit(admin, `bind:${ctx.buyerId}`, BIND_LIMIT.windowSeconds, BIND_LIMIT.limit);
    if (limited === "limited") {
      return noStore(buyerError(429, "RATE_LIMITED", "Too many attempts. Try again later."));
    }
    if (limited === "unavailable") return unavailable();
  }

  // The host's tenant and the session's buyer; never values from the body.
  const { data: result, error } = await admin.rpc("bind_ticket_device" as never, {
    p_ticket_id: params.id,
    p_tenant_id: tenantId,
    p_buyer_id: ctx.buyerId,
    p_public_key: publicKey,
  } as never);
  if (error) {
    console.error("[me/tickets/device] bind failed", (error as { code?: string }).code ?? "");
    return unavailable();
  }
  // 'refused', or anything unexpected: no token.
  if (typeof result !== "string" || !BOUND.has(result)) return notFound();

  const { data: t, error: loadError } = (await admin
    .from("tickets")
    .select("id, intake_id, tier, admits, exp")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single()) as unknown as { data: TicketRow | null; error: { code?: string } | null };
  if (loadError || !t) {
    console.error("[me/tickets/device] ticket load failed", loadError?.code ?? "");
    return unavailable();
  }

  let token: string;
  try {
    token = signBoundTicket(
      { jti: t.id, eid: t.intake_id, tier: t.tier, admits: t.admits, exp: Math.floor(Date.parse(t.exp) / 1000) },
      publicKey,
    );
  } catch {
    console.error("[me/tickets/device] signing failed");
    return unavailable();
  }

  // One email per phone move, not one per seat. Sent on "ok" and on
  // "unavailable": it is the only anti-takeover signal, so a counter outage
  // must not suppress it. Skipped only on "limited".
  if (result === "bound_again") {
    const mailSlot = await consumeRateLimit(admin, `bindmail:${ctx.buyerId}`, MAIL_WINDOW_SECONDS, 1);
    if (mailSlot !== "limited") {
      const mail = ticketNewPhoneEmail({ tier: t.tier });
      const sent = await sendEmail({ to: ctx.email, subject: mail.subject, html: mail.html }).catch(() => false);
      if (!sent) console.error("[me/tickets/device] new-phone email not sent");
    }
  }

  return noStore(NextResponse.json({ token, jti: t.id, serverTime: Math.floor(Date.now() / 1000) }));
}
