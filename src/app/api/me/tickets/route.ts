import { NextResponse } from "next/server";
import { requireBuyer, resolveTenantId } from "@/lib/api";
import { buyerError } from "@/lib/buyers/errors";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── GET /api/me/tickets: this site's account tickets (design 4.5, 6) ───────
//
// The signed-in buyer's tickets on protected events of THIS tenant only, from
// confirmed orders they bought. Each ticket says whether a phone is bound; it
// never carries a token, a QR or a key. The ticket page gets its token from
// POST /api/me/tickets/[id]/device.
//
// Filtered in SQL, then again on the rows returned: a dropped embed filter
// must not list someone else's ticket. Logs fixed strings and codes only.

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
  bound: boolean;
}

interface Row {
  id: string;
  status: string;
  tier: string;
  seat_no: number;
  attendee: { label?: unknown } | null;
  intake_id: string;
  tenant_id: string;
  enrollments: { buyer_id: string | null; status: string } | null;
  intakes: { name: string; ticket_protection: boolean } | null;
  classes: { event_date: string | null; end_time: string | null } | null;
}

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

  const admin = createAdminClient();

  const { data, error } = (await admin
    .from("tickets")
    .select(
      "id, status, tier, seat_no, attendee, intake_id, tenant_id, enrollments!inner(buyer_id, status), intakes!inner(name, ticket_protection), classes(event_date, end_time)",
    )
    .eq("tenant_id", tenantId)
    .eq("enrollments.buyer_id", ctx.buyerId)
    .eq("enrollments.status", "confirmed")
    .eq("intakes.ticket_protection", true)) as unknown as { data: Row[] | null; error: { code?: string } | null };
  if (error || !data) {
    console.error("[me/tickets] ticket read failed", error?.code ?? "");
    return unavailable();
  }

  const rows = data.filter(
    (r) =>
      r.tenant_id === tenantId &&
      r.enrollments?.buyer_id === ctx.buyerId &&
      r.enrollments.status === "confirmed" &&
      r.intakes?.ticket_protection === true,
  );

  let bound = new Set<string>();
  if (rows.length > 0) {
    const { data: devices, error: devError } = (await admin
      .from("ticket_devices")
      .select("ticket_id")
      .in(
        "ticket_id",
        rows.map((r) => r.id),
      )
      .is("revoked_at", null)) as unknown as { data: { ticket_id: string }[] | null; error: { code?: string } | null };
    if (devError || !devices) {
      console.error("[me/tickets] device read failed", devError?.code ?? "");
      return unavailable();
    }
    bound = new Set(devices.map((d) => d.ticket_id));
  }

  const tickets: AccountTicket[] = rows
    .map((r) => ({
      id: r.id,
      status: r.status === "valid" ? ("valid" as const) : ("void" as const),
      eventId: r.intake_id,
      eventName: r.intakes?.name ?? "Event",
      tier: r.tier,
      seatNo: r.seat_no,
      attendeeName: typeof r.attendee?.label === "string" ? r.attendee.label : null,
      eventDate: r.classes?.event_date ?? null,
      endDate: r.classes?.end_time ?? null,
      bound: bound.has(r.id),
    }))
    .sort(
      (a, b) =>
        (a.eventDate ?? "9999").localeCompare(b.eventDate ?? "9999") ||
        a.eventId.localeCompare(b.eventId) ||
        a.tier.localeCompare(b.tier) ||
        a.seatNo - b.seatNo,
    );

  return noStore(NextResponse.json({ tickets }));
}
