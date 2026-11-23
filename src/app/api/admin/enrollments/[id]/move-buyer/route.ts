import { NextRequest, NextResponse } from "next/server";
import { requireOwner, badRequest, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidEmail } from "@/lib/enrollment/emailAddress";
import { sendEmail, orderMovedAwayEmail, orderMovedInEmail } from "@/lib/email";
import { tenantLinkOrigin } from "@/lib/origin";
import { ACCOUNT_TICKETS_PATH } from "@/lib/tickets/accountTickets";

// ─── POST /api/admin/enrollments/[id]/move-buyer ───────────────────────────
// Moves a confirmed order to the buyer's new account (design 4.7): a buyer who
// lost the old mailbox signs up again and asks the organiser. Tenant owner only,
// with a password session (requireOwner). Body: { email, reason }.
//
// Every refusal gives the same answer (design 4.7 step 4), whether no live
// account has that email or move_order_buyer refuses, so the response never says
// which check failed. The tenant, the staff user and the target buyer come from
// the session and the lookup, never from the body.
//
// After a move both addresses are emailed (step 6). A failed send does not undo
// or fail the move: the move is already committed and logged in order_moves.

const MAX_REASON = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSED = { error: "Conflict", message: "This order can't be moved to that account." };

type Profile = { id: string; email: string | null; deleted_at?: string | null };
type Read<T> = { data: T | null; error: unknown };

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId, user, isAgent } = auth;

  // The move record names the person who made it. The bot is not a person.
  if (isAgent) {
    return NextResponse.json(
      { error: "Forbidden", message: "Only a signed-in owner can move an order." },
      { status: 403 },
    );
  }

  // A malformed id would make PostgREST fail the uuid cast: a 404, not a 500.
  if (!UUID_RE.test(params.id)) return notFound("Enrollment");

  let body: { email?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON.");
  }
  if (!body || typeof body !== "object") return badRequest("Invalid JSON.");

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) return badRequest("Enter a valid email address.");

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 1 || reason.length > MAX_REASON) {
    return badRequest(`Enter a reason of 1 to ${MAX_REASON} characters.`);
  }

  const admin = createAdminClient();

  const { data: target, error: targetError } = (await admin
    .from("buyer_profiles" as never)
    .select("id, email")
    .eq("email", email)
    .is("deleted_at", null)
    .maybeSingle()) as unknown as Read<Profile>;

  if (targetError) {
    console.error("[move-buyer] target lookup failed");
    return NextResponse.json({ error: "Could not move the order." }, { status: 500 });
  }
  if (!target) return NextResponse.json(REFUSED, { status: 409 });

  const { data: moveData, error: moveError } = (await admin.rpc(
    "move_order_buyer" as never,
    {
      p_enrollment_id: params.id,
      p_tenant_id: tenantId,
      p_staff_user_id: user.id,
      p_to_buyer_id: target.id,
      p_reason: reason,
    } as never,
  )) as unknown as {
    data: { result?: unknown; from_buyer_id?: string | null }[] | { result?: unknown; from_buyer_id?: string | null } | null;
    error: { code?: string } | null;
  };

  if (moveError) {
    console.error("[move-buyer] move failed:", moveError.code ?? "unknown");
    return NextResponse.json({ error: "Could not move the order." }, { status: 500 });
  }

  // RETURNS TABLE comes back from PostgREST as an array of rows.
  const row = Array.isArray(moveData) ? moveData[0] : moveData;
  if (!row || row.result !== "moved") return NextResponse.json(REFUSED, { status: 409 });

  await notifyBothAddresses({
    admin,
    enrollmentId: params.id,
    tenantId,
    fromBuyerId: row.from_buyer_id ?? null,
    toEmail: target.email,
  });

  return NextResponse.json({ ok: true });
}

/** Never throws; logs fixed strings only (no address, no provider message). */
async function notifyBothAddresses(input: {
  admin: ReturnType<typeof createAdminClient>;
  enrollmentId: string;
  tenantId: string;
  fromBuyerId: string | null;
  toEmail: string | null;
}): Promise<void> {
  const { admin, enrollmentId, tenantId, fromBuyerId, toEmail } = input;
  try {
    const [orderRead, tenantRead, oldRead] = (await Promise.all([
      admin
        .from("enrollments")
        .select("enrollment_ref")
        .eq("id", enrollmentId)
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      admin
        .from("tenants")
        .select("name, subdomain, logo_url")
        .eq("id", tenantId)
        .maybeSingle(),
      fromBuyerId
        ? admin
            .from("buyer_profiles" as never)
            .select("id, email, deleted_at")
            .eq("id", fromBuyerId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])) as unknown as [
      Read<{ enrollment_ref: string }>,
      Read<{ name: string; subdomain: string | null; logo_url: string | null }>,
      Read<Profile>,
    ];

    if (orderRead.error || !orderRead.data || tenantRead.error || !tenantRead.data) {
      console.error("[move-buyer] moved; email details lookup failed, no email sent");
      return;
    }
    if (oldRead.error) console.error("[move-buyer] moved; old account lookup failed");

    const ref = orderRead.data.enrollment_ref;
    const tenantName = tenantRead.data.name;
    const logoUrl = tenantRead.data.logo_url ?? undefined;
    const myTicketsUrl = new URL(
      ACCOUNT_TICKETS_PATH,
      tenantLinkOrigin(tenantRead.data.subdomain),
    ).toString();

    const oldEmail =
      oldRead.data && !oldRead.data.deleted_at && oldRead.data.email ? oldRead.data.email : null;

    const sends: Promise<boolean>[] = [];
    if (oldEmail) {
      sends.push(sendEmail({ to: oldEmail, ...orderMovedAwayEmail({ enrollmentRef: ref, tenantName, logoUrl }) }));
    }
    if (toEmail) {
      sends.push(
        sendEmail({ to: toEmail, ...orderMovedInEmail({ enrollmentRef: ref, tenantName, myTicketsUrl, logoUrl }) }),
      );
    }

    const results = await Promise.allSettled(sends);
    if (results.some((r) => r.status === "rejected" || r.value !== true)) {
      console.error("[move-buyer] moved; an email was not sent");
    }
  } catch {
    console.error("[move-buyer] moved; emails failed");
  }
}
