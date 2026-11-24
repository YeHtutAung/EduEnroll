import { NextRequest, NextResponse } from "next/server";
import { requireAuth, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { maskEmail } from "@/lib/maskEmail";

// ─── GET /api/admin/enrollments/[id]/account ───────────────────────────────
// Read-only view of an account order (design 9): the buyer's masked email, each
// ticket's phone status, and the order-move history. There is no "Reset phone"
// (design 2). Never returns a public key, a token, a buyer id or a full email.
//
// Masking choices:
// - buyer: null when the order has no buyer_id; { email: "***" } when it has one
//   but the profile is missing or deleted (an account that was deleted stays hidden).
// - a move's from / to: null when that side has no buyer id; "***" when the id is
//   set but the profile is missing or deleted.
// - movedBy: the staff member's full_name, or "Staff".
// - holder: the masked friend who holds a seat, or null while it is with the buyer
//   ("***" when that account was deleted or is missing).
// - history[].by: a masked buyer email, the staff member's name (or "Staff"), or
//   null when nobody acted (voided). from / to follow the same masking as moves.

type Ticket = {
  id: string;
  tier: string;
  seat_no: number;
  status: string;
  holder_buyer_id: string | null;
};
type Device = { ticket_id: string; created_at: string; revoked_at: string | null };
type Move = {
  created_at: string;
  from_buyer_id: string | null;
  to_buyer_id: string | null;
  moved_by: string | null;
  reason: string;
};
type HolderEvent = {
  ticket_id: string;
  event: string;
  actor_buyer_id: string | null;
  actor_staff_id: string | null;
  from_buyer_id: string | null;
  to_buyer_id: string | null;
  created_at: string;
};
type Profile = { id: string; email: string | null; deleted_at: string | null };
type Staff = { id: string; full_name: string | null };
type Read<T> = { data: T[] | null; error: unknown };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { tenantId, isAgent } = auth;

  // Who holds a paid ticket is for a signed-in person, not the bot.
  if (isAgent) {
    return NextResponse.json(
      { error: "Forbidden", message: "Only a signed-in admin can view an order's account." },
      { status: 403 },
    );
  }

  // A malformed id would make PostgREST fail the uuid cast: a 404, not a 500.
  if (!UUID_RE.test(params.id)) return notFound("Enrollment");

  const admin = createAdminClient();
  const failed = () => {
    console.error("[order-account] read failed");
    return NextResponse.json({ error: "Could not load the order's account." }, { status: 500 });
  };

  const { data: enrollment, error: lookupError } = (await admin
    .from("enrollments")
    .select("id, buyer_id")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .maybeSingle()) as unknown as {
    data: { id: string; buyer_id: string | null } | null;
    error: unknown;
  };

  if (lookupError) {
    console.error("[order-account] order lookup failed");
    return NextResponse.json({ error: "Could not load the order's account." }, { status: 500 });
  }
  if (!enrollment) return notFound("Enrollment");

  const [ticketRead, moveRead] = (await Promise.all([
    admin
      .from("tickets")
      .select("id, tier, seat_no, status, holder_buyer_id")
      .eq("enrollment_id", enrollment.id)
      .eq("tenant_id", tenantId)
      .order("seat_no", { ascending: true }),
    admin
      .from("order_moves" as never)
      .select("created_at, from_buyer_id, to_buyer_id, moved_by, reason")
      .eq("enrollment_id", enrollment.id)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
  ])) as unknown as [Read<Ticket>, Read<Move>];

  if (ticketRead.error || !ticketRead.data || moveRead.error || !moveRead.data) return failed();
  const tickets = ticketRead.data;
  const moves = moveRead.data;

  const none = Promise.resolve({ data: [], error: null });
  const ticketIds = tickets.map((t) => t.id);

  const [deviceRead, linkRead, eventRead] = (await Promise.all([
    tickets.length > 0
      ? admin
          .from("ticket_devices" as never)
          .select("ticket_id, created_at, revoked_at")
          .in("ticket_id", ticketIds)
      : none,
    // Open links only: not claimed, not cancelled. Only the ticket id is read.
    tickets.length > 0
      ? admin
          .from("ticket_share_links" as never)
          .select("ticket_id")
          .in("ticket_id", ticketIds)
          .is("claimed_at", null)
          .is("cancelled_at", null)
      : none,
    tickets.length > 0
      ? admin
          .from("ticket_holder_events" as never)
          .select("ticket_id, event, actor_buyer_id, actor_staff_id, from_buyer_id, to_buyer_id, created_at")
          .in("ticket_id", ticketIds)
          .order("created_at", { ascending: true })
      : none,
  ])) as unknown as [Read<Device>, Read<{ ticket_id: string }>, Read<HolderEvent>];

  if (
    deviceRead.error || !deviceRead.data ||
    linkRead.error || !linkRead.data ||
    eventRead.error || !eventRead.data
  ) {
    return failed();
  }
  const events = eventRead.data;

  const buyerIds = Array.from(
    new Set(
      [
        enrollment.buyer_id,
        ...tickets.map((t) => t.holder_buyer_id),
        ...moves.flatMap((m) => [m.from_buyer_id, m.to_buyer_id]),
        ...events.flatMap((e) => [e.actor_buyer_id, e.from_buyer_id, e.to_buyer_id]),
      ].filter((id): id is string => !!id),
    ),
  );
  const staffIds = Array.from(
    new Set(
      [...moves.map((m) => m.moved_by), ...events.map((e) => e.actor_staff_id)].filter(
        (id): id is string => !!id,
      ),
    ),
  );

  const [profileRead, staffRead] = (await Promise.all([
    buyerIds.length > 0
      ? admin.from("buyer_profiles" as never).select("id, email, deleted_at").in("id", buyerIds)
      : none,
    staffIds.length > 0
      ? admin.from("users").select("id, full_name").in("id", staffIds).eq("tenant_id", tenantId)
      : none,
  ])) as unknown as [Read<Profile>, Read<Staff>];

  if (
    profileRead.error || !profileRead.data ||
    staffRead.error || !staffRead.data
  ) {
    return failed();
  }

  const emailById = new Map<string, string>();
  for (const p of profileRead.data) {
    if (!p.deleted_at) emailById.set(p.id, maskEmail(p.email));
  }
  const shownEmail = (id: string | null) => (id ? (emailById.get(id) ?? "***") : null);

  const staffName = new Map(staffRead.data.map((s) => [s.id, s.full_name]));
  const staffShown = (id: string) => staffName.get(id)?.trim() || "Staff";

  // linkOpen: an open link row exists (not claimed, not cancelled). The claim
  // itself re-checks the cutoff, so a link that is past it can still read as open here.
  const openLinks = new Set(linkRead.data.map((l) => l.ticket_id));
  const historyByTicket = new Map<string, unknown[]>();
  for (const e of events) {
    const by = e.actor_buyer_id
      ? shownEmail(e.actor_buyer_id)
      : e.actor_staff_id
        ? staffShown(e.actor_staff_id)
        : null;
    const list = historyByTicket.get(e.ticket_id) ?? [];
    list.push({
      at: e.created_at,
      event: e.event,
      by,
      from: shownEmail(e.from_buyer_id),
      to: shownEmail(e.to_buyer_id),
    });
    historyByTicket.set(e.ticket_id, list);
  }

  const active = new Set<string>();
  const lastBound = new Map<string, string>();
  for (const d of deviceRead.data) {
    if (d.revoked_at === null) active.add(d.ticket_id);
    const prev = lastBound.get(d.ticket_id);
    if (!prev || new Date(d.created_at).getTime() > new Date(prev).getTime()) {
      lastBound.set(d.ticket_id, d.created_at);
    }
  }

  return NextResponse.json(
    {
      buyer: enrollment.buyer_id ? { email: shownEmail(enrollment.buyer_id) } : null,
      tickets: tickets.map((t) => ({
        id: t.id,
        tier: t.tier,
        seatNo: t.seat_no,
        status: t.status,
        bound: active.has(t.id),
        lastBoundAt: lastBound.get(t.id) ?? null,
        holder: shownEmail(t.holder_buyer_id),
        linkOpen: openLinks.has(t.id),
        history: historyByTicket.get(t.id) ?? [],
      })),
      moves: moves.map((m) => ({
        createdAt: m.created_at,
        from: shownEmail(m.from_buyer_id),
        to: shownEmail(m.to_buyer_id),
        reason: m.reason,
        movedBy: m.moved_by ? staffShown(m.moved_by) : "Staff",
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
