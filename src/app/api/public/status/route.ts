import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { statusTicketAmounts } from "@/lib/payments/statusTicketAmounts";
import type { Enrollment, Class, Intake, Payment } from "@/types/database";
import type { PaymentStatus } from "@/types/database";
import { loadPartialPayment } from "@/server/payments/partialPayment";
import { enrollmentStatusLabels, statusNotFoundMessage } from "@/lib/enrollment/orderWording";
import { clientIpFrom, publicEnrollmentLookupLimiter } from "@/lib/rateLimit";

// The answer is about one buyer's order, so no shared cache may keep a copy.
const NO_STORE = { "Cache-Control": "no-store" };

function noStore<T extends Response>(res: T): T {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

// Same budget as /api/public/enrollment/[ref]: both routes answer for the same
// references, so a miss on either spends it.
function throttled(clientIp: string) {
  return NextResponse.json(
    { error: "Too Many Requests", message: "Too many failed lookups. Try again later." },
    {
      status: 429,
      headers: { ...NO_STORE, "Retry-After": String(publicEnrollmentLookupLimiter.retryAfter(clientIp)) },
    },
  );
}

// Only "no such row" counts. A database fault is not a miss, or an outage would
// spend the budget of callers whose references are valid. PGRST116 is what
// PostgREST returns from .single() when no row matched.
function recordIfDefinitelyAbsent(clientIp: string, error: unknown): void {
  const code = (error as { code?: string } | null)?.code;
  if (!error || code === "PGRST116") {
    publicEnrollmentLookupLimiter.recordMiss(clientIp);
    return;
  }
  console.error("[status] enrollment lookup failed, not counted as a miss:", code ?? "unknown");
}

// ─── Bilingual status labels ──────────────────────────────────────────────────

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, { en: string; mm: string }> = {
  awaiting_payment: {
    en: "Awaiting Payment",
    mm: "ငွေပေးချေမှု စောင့်ဆိုင်းနေသည်",
  },
  pending: {
    en: "Pending Verification",
    mm: "အတည်ပြုမှု စောင့်ဆိုင်းဆဲ",
  },
  verified: {
    en: "Payment Verified",
    mm: "ငွေပေးချေမှု အတည်ပြုပြီး",
  },
  rejected: {
    en: "Payment Rejected",
    mm: "ငွေပေးချေမှု ငြင်းဆိုထားသည်",
  },
};

// ─── Joined row types ─────────────────────────────────────────────────────────

interface EnrollmentWithClass extends Enrollment {
  classes: Pick<Class, "id" | "level" | "fee_amount" | "image_url" | "pack_size"> & {
    intakes: Pick<Intake, "name" | "year" | "slug"> | null;
  } | null;
}

type EnrollmentResult = { data: EnrollmentWithClass | null; error: unknown };
type PaymentResult    = { data: Pick<Payment, "id" | "status" | "created_at" | "admin_note" | "received_amount" | "amount" | "platform_fee"> | null; error: unknown };

// ─── GET /api/public/status?ref=NM-2026-XXXXX ─────────────────────────────────
// Public — no authentication required.
//
// Query param:
//   ref   string   (required)  e.g. "NM-2026-00042"
//
// Success 200:
// {
//   enrollment_ref:     "NM-2026-00042"
//   student_name_en:    "Mg Mg"
//   student_name_mm:    "မောင်မောင်" | null
//   class_level:        "N5"
//   fee_amount:         300000 // ticket line total
//   unit_fee_amount:    150000 // single-class unit price, otherwise null
//   fee_formatted:      "၃၀၀,၀၀၀ MMK"
//   status:             "payment_submitted"
//   status_label_en:    "Payment Under Review"
//   status_label_mm:    "ငွေပေးချေမှု စစ်ဆေးနေဆဲ"
//   payment: {
//     id:               "uuid" | null
//     status:           "pending" | "verified" | "rejected" | null
//     status_label_en:  string | null
//     status_label_mm:  string | null
//     submitted_at:     string | null
//   } | null
// }
//
// The reference is the only credential here, so failed lookups are throttled
// per client address on the shared enrollment-lookup budget. Only misses count:
// the payment page polls this route with a valid reference, and those polls
// must never be refused. Once the budget is spent every request from that
// address is refused, hits included. Do not remove that without replacing it.

export async function GET(request: NextRequest) {
  // Cheapest possible rejection, so a spent address costs no tenant lookup.
  const clientIp = clientIpFrom(request.headers);
  if (publicEnrollmentLookupLimiter.isBlocked(clientIp)) {
    return throttled(clientIp);
  }

  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return noStore(tenantId);

  const ref = request.nextUrl.searchParams.get("ref")?.trim();

  if (!ref) {
    return NextResponse.json(
      { error: "Bad Request", message: "Query parameter 'ref' is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  const supabase = createAdminClient();

  // ── Fetch enrollment with class info ─────────────────────────────
  const { data: enrollment, error: enrollmentError } = await supabase
    .from("enrollments")
    .select("*, classes(id, level, fee_amount, image_url, pack_size, intakes(name, year, slug))")
    .eq("enrollment_ref", ref)
    .eq("tenant_id", tenantId)
    .single() as EnrollmentResult;

  if (enrollmentError || !enrollment) {
    recordIfDefinitelyAbsent(clientIp, enrollmentError);

    // The lookup is scoped to this tenant, so a reference that belongs to
    // another tenant gets exactly this answer too. Nothing below depends on
    // the reference: the wording comes from the current tenant only.
    //
    // The not-found screens have no order to take the tenant's wording from.
    // A failed read stays unknown, the same as the success response below.
    const { data: tenantOrg } = await supabase
      .from("tenants")
      .select("org_type")
      .eq("id", tenantId)
      .maybeSingle() as { data: { org_type: string } | null; error: unknown };
    const orgType = tenantOrg?.org_type ?? null;

    return NextResponse.json(
      { error: "Not Found", message: statusNotFoundMessage(orgType), org_type: orgType },
      { status: 404, headers: NO_STORE },
    );
  }

  // ── Fetch most recent payment (if any) ───────────────────────────
  const { data: payment } = await supabase
    .from("payments")
    .select("id, status, created_at, admin_note, received_amount, amount, platform_fee")
    .eq("enrollment_id", enrollment.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single() as PaymentResult;

  // ── Fetch enrollment items for cart enrollments ──────────────────
  let cartItems: { class_level: string; quantity: number; fee_amount: number; subtotal: number; image_url: string | null }[] | null = null;
  // People admitted: a "GA 3-Pack" line is quantity 1 but three tickets. The
  // payment page's per_ticket fee preview counts this, as the routes do.
  let ticketCount = (enrollment.quantity ?? 1) * Math.max(1, enrollment.classes?.pack_size ?? 1);
  let cartIntakeInfo: Pick<Intake, "name" | "year" | "slug"> | null = null;

  if (enrollment.class_id === null) {
    const { data: items } = await supabase
      .from("enrollment_items")
      .select("quantity, fee_amount, classes(level, image_url, pack_size, intakes(name, year, slug))")
      .eq("enrollment_id", enrollment.id) as {
      data: { quantity: number; fee_amount: number; classes: { level: string; image_url: string | null; pack_size: number | null; intakes: Pick<Intake, "name" | "year" | "slug"> | null } | null }[] | null;
      error: unknown;
    };

    if (items && items.length > 0) {
      ticketCount = items.reduce((n, i) => n + i.quantity * Math.max(1, i.classes?.pack_size ?? 1), 0);
      cartItems = items.map((i) => ({
        class_level: i.classes?.level ?? "Unknown",
        quantity: i.quantity,
        fee_amount: i.fee_amount,
        subtotal: i.fee_amount * i.quantity,
        image_url: i.classes?.image_url ?? null,
      }));
      // Get intake info from first cart item (all items share the same intake)
      const firstIntake = items[0]?.classes?.intakes;
      if (firstIntake && !enrollment.classes?.intakes) {
        cartIntakeInfo = firstIntake;
      }
    }
  }

  // ── Build response ────────────────────────────────────────────────
  // Display only, so an unreadable history falls back to the latest row. That row
  // is often a top-up holding only the remainder, or one with nothing recorded.
  // A confirmed order reads it too: its latest row can be a settled top-up, which
  // is a remainder and says nothing about the order total or its fee.
  const partial = enrollment.status === "partial_payment" || enrollment.status === "confirmed"
    ? await loadPartialPayment(supabase, enrollment.id)
    : null;
  const recordedPartial = partial && partial.orderTotal !== null ? partial : null;
  const owingPartial = enrollment.status === "partial_payment" ? recordedPartial : null;

  const paymentBlock = payment
    ? {
        id:                  payment.id,
        status:              payment.status,
        status_label_en:     PAYMENT_STATUS_LABELS[payment.status].en,
        status_label_mm:     PAYMENT_STATUS_LABELS[payment.status].mm,
        submitted_at:        payment.created_at,
        admin_note:          payment.admin_note ?? null,
        received_amount: owingPartial?.received ?? payment.received_amount ?? null,
        total_amount:    recordedPartial?.orderTotal ?? payment.amount,
        // The fee inside total_amount, as recorded when the row was created.
        platform_fee:    recordedPartial?.orderFee ?? payment.platform_fee ?? 0,
        remaining_amount: owingPartial
          ? owingPartial.remaining
          : payment.received_amount != null
            ? payment.amount - payment.received_amount
            : null,
      }
    : null;

  // ── Build intake slug (e.g. "april-2026") ────────────────────────
  const intakeInfo = enrollment.classes?.intakes ?? cartIntakeInfo;
  const intakeSlug = intakeInfo
    ? (intakeInfo.slug ?? `${intakeInfo.name.toLowerCase().replace(/\s+/g, "-")}-${intakeInfo.year}`)
    : null;

  // `feeAmount` is the ticket line total in either shape. Single-class
  // responses also carry their unit price explicitly, rather than making a
  // client recover it by dividing the total by quantity.
  const { feeAmount: displayFee, unitFeeAmount } = statusTicketAmounts(
    cartItems,
    enrollment.classes?.fee_amount ?? null,
    enrollment.quantity,
  );

  // ── Fetch tenant org_type ─────────────────────────────────────
  const { data: tenantInfo, error: tenantError } = await supabase
    .from("tenants")
    .select("org_type, currency, auto_cancel_hours, payment_mode, mmqr_provider, platform_fee_mode, platform_fee_amount")
    .eq("id", tenantId)
    .single() as { data: { org_type: string; currency: string; auto_cancel_hours: number; payment_mode: string; mmqr_provider: string; platform_fee_mode: string | null; platform_fee_amount: number | null } | null; error: unknown };

  if (tenantError || !tenantInfo) {
    console.error("[status] tenant lookup failed for", tenantId, tenantError ?? "no row");
  }

  const enrollmentLabel = enrollmentStatusLabels(tenantInfo?.org_type)[enrollment.status];

  // Bots live in tenant_bots (moved in migration 071). Buyers link to the
  // enrollment bot, and a tenant without one is normal, hence maybeSingle.
  const { data: enrollmentBot, error: botError } = await supabase
    .from("tenant_bots")
    .select("bot_username, enabled")
    .eq("tenant_id", tenantId)
    .eq("bot_type", "enrollment")
    .maybeSingle() as { data: { bot_username: string | null; enabled: boolean } | null; error: unknown };

  if (botError) {
    console.error("[status] enrollment bot lookup failed for", tenantId, botError);
  }

  return NextResponse.json({
    enrollment_ref:   enrollment.enrollment_ref,
    student_name_en:  enrollment.student_name_en,
    student_name_mm:  enrollment.student_name_mm ?? null,
    class_id:         enrollment.classes?.id ?? null,
    class_level:      cartItems
                        ? cartItems.map((i) => i.class_level).join(", ")
                        : (enrollment.classes?.level ?? null),
    fee_amount:          displayFee,
    unit_fee_amount:     unitFeeAmount,
    fee_formatted:    displayFee != null ? formatCurrency(displayFee, tenantInfo?.currency || "MMK") : null,
    currency:         tenantInfo?.currency || "MMK",
    quantity:          enrollment.quantity ?? 1,
    ticket_count:      ticketCount,
    intake_slug:      intakeSlug,
    status:           enrollment.status,
    status_label_en:  enrollmentLabel.en,
    status_label_mm:  enrollmentLabel.mm,
    payment:          paymentBlock,
    class_image_url:  enrollment.classes?.image_url ?? null,
    items:            cartItems,
    // NULL, not a default. Reporting "language_school" for a tenant we could
    // not read tells the payment page this order is positively ticketless,
    // which re-enables the QR-less receipt for an event order whose ticket
    // list is empty — the exact defect the gate there was built to close.
    // Unknown has to stay unknown all the way to the consumer.
    org_type:         tenantInfo?.org_type ?? null,
    enrolled_at:      enrollment.enrolled_at,
    auto_cancel_minutes: tenantInfo?.auto_cancel_hours ?? 4320,
    telegram_bot_username: enrollmentBot?.enabled ? (enrollmentBot.bot_username ?? null) : null,
    payment_mode: tenantInfo?.payment_mode ?? "bank_transfer",
    // Fee settings, so the payment and confirmation screens can show the split
    // rather than a single figure the buyer cannot account for.
    platform_fee_mode: tenantInfo?.platform_fee_mode ?? "none",
    platform_fee_amount: tenantInfo?.platform_fee_amount ?? 0,
    mmqr_provider: tenantInfo?.mmqr_provider ?? "abank",
  }, { headers: NO_STORE });
}
