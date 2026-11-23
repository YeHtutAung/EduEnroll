import { NextResponse } from "next/server";
import { requireBuyer, resolveTenantId } from "@/lib/api";
import { buyerError } from "@/lib/buyers/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { maskEmail } from "@/lib/maskEmail";
import { shareCutoffAt } from "@/lib/tickets/exp";

// ─── GET /api/me/tickets: this site's account tickets (design 4.5, 6, 6.4) ──
//
// The signed-in buyer's tickets on protected events of THIS tenant only, from
// confirmed orders: the seats on orders they bought (role "leader") and the
// seats a leader shared that they claimed (role "holder"). Each ticket says
// whether the viewer's phone is bound; it never carries a token, a QR, a key,
// a full email address or another buyer's id. The ticket page gets its token
// from POST /api/me/tickets/[id]/device.
//
// Filtered in SQL, then again on the rows returned: a dropped embed filter
// must not list someone else's ticket. The share flags are for display only;
// every sharing decision is made in SQL under the ticket lock. Logs fixed
// strings and codes only.

export const dynamic = "force-dynamic";

export interface AccountTicket {
  id: string;
  status: "valid" | "void";
  /** The intake id: groups tickets by event (two events may share a name). */
  eventId: string;
  eventName: string;
  tier: string;
  seatNo: number;
  attendeeName: string | null;
  eventDate: string | null;
  endDate: string | null;
  /** The viewer's own phone is bound. Always false for a seat shared away. */
  bound: boolean;
  role: "leader" | "holder";
  /** Masked address of the friend holding this seat; leader only. */
  sharedWith: string | null;
  /** Masked address of the order's leader; holder only. */
  leaderEmail: string | null;
  /**
   * An unclaimed, uncancelled link exists and the seat is still claimable
   * (the live cutoff from the class's current event_date, not the stored
   * expires_at, as claim_share_link decides); leader only.
   */
  linkOpen: boolean;
  canShare: boolean;
  canGiveBack: boolean;
  /** When sharing closes (Unix seconds), from shareCutoffAt(eventDate). */
  shareClosesAt: number | null;
}

interface Row {
  id: string;
  status: string;
  tier: string;
  seat_no: number;
  attendee: { label?: unknown } | null;
  intake_id: string;
  tenant_id: string;
  holder_buyer_id: string | null;
  first_scan_at: string | null;
  enrollments: { buyer_id: string | null; status: string } | null;
  intakes: { name: string; ticket_protection: boolean } | null;
  classes: { event_date: string | null; end_time: string | null } | null;
}

type Read<T> = { data: T | null; error: { code?: string } | null };

const SELECT =
  "id, status, tier, seat_no, attendee, intake_id, tenant_id, holder_buyer_id, first_scan_at, enrollments!inner(buyer_id, status), intakes!inner(name, ticket_protection), classes(event_date, end_time)";

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const unavailable = () => noStore(buyerError(503, "SERVER", "Please try again."));

export async function GET(): Promise<NextResponse> {
  const ctx = await requireBuyer();
  if (ctx instanceof NextResponse) return noStore(ctx);
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return noStore(tenantId);
  const buyerId = ctx.buyerId;

  const admin = createAdminClient();
  const ticketQuery = () =>
    admin
      .from("tickets")
      .select(SELECT)
      .eq("tenant_id", tenantId)
      .eq("enrollments.status", "confirmed")
      .eq("intakes.ticket_protection", true);

  const [led, held] = (await Promise.all([
    ticketQuery().eq("enrollments.buyer_id", buyerId),
    ticketQuery().eq("holder_buyer_id", buyerId),
  ])) as unknown as [Read<Row[]>, Read<Row[]>];
  if (led.error || !led.data || held.error || !held.data) {
    console.error("[me/tickets] ticket read failed", led.error?.code ?? held.error?.code ?? "");
    return unavailable();
  }

  const listable = (r: Row) =>
    r.tenant_id === tenantId && r.enrollments?.status === "confirmed" && r.intakes?.ticket_protection === true;
  // A seat can't be in both (a leader can't claim their own seat), but dedupe anyway.
  const byId = new Map<string, Row>();
  for (const r of led.data) if (listable(r) && r.enrollments?.buyer_id === buyerId) byId.set(r.id, r);
  for (const r of held.data) if (listable(r) && r.holder_buyer_id === buyerId) byId.set(r.id, r);
  const rows = Array.from(byId.values());

  // A seat this buyer holds as a friend is theirs to give back, even on an
  // order later moved to them (plan decision 11).
  const roleOf = (r: Row): "leader" | "holder" => (r.holder_buyer_id === buyerId ? "holder" : "leader");
  const heldIds = rows.filter((r) => r.holder_buyer_id === null || r.holder_buyer_id === buyerId).map((r) => r.id);
  const leaderHeldIds = rows.filter((r) => r.holder_buyer_id === null).map((r) => r.id);
  const profileIds = new Set<string>();
  for (const r of rows) {
    if (roleOf(r) === "leader" && r.holder_buyer_id) profileIds.add(r.holder_buyer_id);
    if (roleOf(r) === "holder" && r.enrollments?.buyer_id) profileIds.add(r.enrollments.buyer_id);
  }

  // Only seats the viewer holds, and only the viewer's own phone.
  let bound = new Set<string>();
  if (heldIds.length > 0) {
    const { data: devices, error: devError } = (await admin
      .from("ticket_devices")
      .select("ticket_id")
      .in("ticket_id", heldIds)
      .eq("buyer_id", buyerId)
      .is("revoked_at", null)) as unknown as Read<{ ticket_id: string }[]>;
    if (devError || !devices) {
      console.error("[me/tickets] device read failed", devError?.code ?? "");
      return unavailable();
    }
    bound = new Set(devices.map((d) => d.ticket_id));
  }

  const nowMs = Date.now();
  let openLinks = new Set<string>();
  if (leaderHeldIds.length > 0) {
    const { data: links, error: linkError } = (await admin
      .from("ticket_share_links")
      .select("ticket_id")
      .in("ticket_id", leaderHeldIds)
      .is("claimed_at", null)
      .is("cancelled_at", null)) as unknown as Read<{ ticket_id: string }[]>;
    if (linkError || !links) {
      console.error("[me/tickets] link read failed", linkError?.code ?? "");
      return unavailable();
    }
    openLinks = new Set(links.map((l) => l.ticket_id));
  }

  const emails = new Map<string, string | null>();
  if (profileIds.size > 0) {
    const { data: profiles, error: profileError } = (await admin
      .from("buyer_profiles")
      .select("id, email")
      .in("id", Array.from(profileIds))
      .is("deleted_at", null)) as unknown as Read<{ id: string; email: string | null }[]>;
    if (profileError || !profiles) {
      console.error("[me/tickets] profile read failed", profileError?.code ?? "");
      return unavailable();
    }
    for (const p of profiles) emails.set(p.id, p.email);
  }
  // A deleted or missing profile shows "***". Presence here means a live
  // profile: the read above filters deleted_at.
  const masked = (id: string | null | undefined) => maskEmail(id ? emails.get(id) : null);

  const nowSec = nowMs / 1000;
  const tickets: AccountTicket[] = rows
    .map((r) => {
      const role = roleOf(r);
      const eventDate = r.classes?.event_date ?? null;
      const shareClosesAt = shareCutoffAt(eventDate);
      const movable =
        r.status === "valid" && r.first_scan_at === null && shareClosesAt !== null && nowSec < shareClosesAt;
      const sharedAway = role === "leader" && r.holder_buyer_id !== null;
      const leaderId = r.enrollments?.buyer_id ?? null;
      return {
        id: r.id,
        status: r.status === "valid" ? ("valid" as const) : ("void" as const),
        eventId: r.intake_id,
        eventName: r.intakes?.name ?? "Event",
        tier: r.tier,
        seatNo: r.seat_no,
        attendeeName: typeof r.attendee?.label === "string" ? r.attendee.label : null,
        eventDate,
        endDate: r.classes?.end_time ?? null,
        bound: !sharedAway && bound.has(r.id),
        role,
        sharedWith: sharedAway ? masked(r.holder_buyer_id) : null,
        leaderEmail: role === "holder" ? masked(r.enrollments?.buyer_id) : null,
        linkOpen: role === "leader" && !sharedAway && movable && openLinks.has(r.id),
        canShare: role === "leader" && !sharedAway && movable,
        // give_back_seat refuses an order with no leader or a leader whose
        // profile is deleted, so the flag does too.
        canGiveBack: role === "holder" && movable && !!leaderId && emails.has(leaderId),
        shareClosesAt,
      };
    })
    .sort(
      (a, b) =>
        (a.eventDate ?? "9999").localeCompare(b.eventDate ?? "9999") ||
        a.eventId.localeCompare(b.eventId) ||
        a.tier.localeCompare(b.tier) ||
        a.seatNo - b.seatNo,
    );

  return noStore(NextResponse.json({ tickets }));
}
