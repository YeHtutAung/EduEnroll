import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatMMK } from "@/lib/utils";
import type { Enrollment, Class, Intake, Payment } from "@/types/database";
import type { EnrollmentStatus, PaymentStatus } from "@/types/database";

// ─── Bilingual status labels ──────────────────────────────────────────────────

const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, { en: string; mm: string }> = {
  pending_payment: {
    en: "Awaiting Payment",
    mm: "ငွေပေးချေမှု စောင့်ဆိုင်းဆဲ",
  },
  payment_submitted: {
    en: "Payment Under Review",
    mm: "ငွေပေးချေမှု စစ်ဆေးနေဆဲ",
  },
  partial_payment: {
    en: "Partial Payment — Please Complete",
    mm: "ငွေတစ်စိတ်တစ်ပိုင်း — ကျန်ငွေ ပေးချေပါ",
  },
  confirmed: {
    en: "Enrollment Confirmed",
    mm: "စာရင်းသွင်းမှု အတည်ပြုပြီး",
  },
  rejected: {
    en: "Enrollment Rejected",
    mm: "စာရင်းသွင်းမှု ငြင်းဆိုထားသည်",
  },
};

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, { en: string; mm: string }> = {
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
  classes: Pick<Class, "id" | "level" | "fee_mmk"> & {
    intakes: Pick<Intake, "name" | "year" | "slug"> | null;
  } | null;
}

type EnrollmentResult = { data: EnrollmentWithClass | null; error: unknown };
type PaymentResult    = { data: Pick<Payment, "id" | "status" | "created_at" | "admin_note" | "received_amount_mmk" | "amount_mmk"> | null; error: unknown };

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
//   fee_mmk:            300000
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

export async function GET(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const ref = request.nextUrl.searchParams.get("ref")?.trim();

  if (!ref) {
    return NextResponse.json(
      { error: "Bad Request", message: "Query parameter 'ref' is required." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // ── Fetch enrollment with class info ─────────────────────────────
  const { data: enrollment, error: enrollmentError } = await supabase
    .from("enrollments")
    .select("*, classes(id, level, fee_mmk, intakes(name, year, slug))")
    .eq("enrollment_ref", ref)
    .eq("tenant_id", tenantId)
    .single() as EnrollmentResult;

  if (enrollmentError || !enrollment) {
    return NextResponse.json(
      { error: "Not Found", message: "No enrollment found for this reference." },
      { status: 404 },
    );
  }

  // ── Fetch most recent payment (if any) ───────────────────────────
  const { data: payment } = await supabase
    .from("payments")
    .select("id, status, created_at, admin_note, received_amount_mmk, amount_mmk")
    .eq("enrollment_id", enrollment.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single() as PaymentResult;

  // ── Build response ────────────────────────────────────────────────
  const enrollmentLabel = ENROLLMENT_STATUS_LABELS[enrollment.status];

  const paymentBlock = payment
    ? {
        id:                  payment.id,
        status:              payment.status,
        status_label_en:     PAYMENT_STATUS_LABELS[payment.status].en,
        status_label_mm:     PAYMENT_STATUS_LABELS[payment.status].mm,
        submitted_at:        payment.created_at,
        admin_note:          payment.admin_note ?? null,
        received_amount_mmk: payment.received_amount_mmk ?? null,
        total_amount_mmk:    payment.amount_mmk,
        remaining_amount_mmk: payment.received_amount_mmk != null
          ? payment.amount_mmk - payment.received_amount_mmk
          : null,
      }
    : null;

  // ── Build intake slug (e.g. "april-2026") ────────────────────────
  const intakeInfo = enrollment.classes?.intakes;
  const intakeSlug = intakeInfo
    ? (intakeInfo.slug ?? `${intakeInfo.name.toLowerCase().replace(/\s+/g, "-")}-${intakeInfo.year}`)
    : null;

  return NextResponse.json({
    enrollment_ref:   enrollment.enrollment_ref,
    student_name_en:  enrollment.student_name_en,
    student_name_mm:  enrollment.student_name_mm ?? null,
    class_id:         enrollment.classes?.id ?? null,
    class_level:      enrollment.classes?.level ?? null,
    fee_mmk:          enrollment.classes?.fee_mmk ?? null,
    fee_formatted:    enrollment.classes?.fee_mmk != null
                        ? formatMMK(enrollment.classes.fee_mmk)
                        : null,
    quantity:          enrollment.quantity ?? 1,
    intake_slug:      intakeSlug,
    status:           enrollment.status,
    status_label_en:  enrollmentLabel.en,
    status_label_mm:  enrollmentLabel.mm,
    payment:          paymentBlock,
  });
}
