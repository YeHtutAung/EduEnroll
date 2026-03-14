import { NextRequest, NextResponse } from "next/server";
import { requireAuth, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Enrollment, Class, Intake, Payment } from "@/types/database";

const SIGNED_URL_EXPIRES_IN = 3600; // 1 hour
const PROOF_BUCKET = "payment-proofs";

type EnrollmentJoined = Enrollment & {
  classes:
    | (Pick<Class, "level" | "fee_mmk"> & {
        intakes: Pick<Intake, "name"> | null;
      })
    | null;
};

// ─── GET /api/admin/students/[id] ────────────────────────────────────────────
// Returns full enrollment detail for a single enrollment by ID.
// Includes nrc_number, email, and most recent payment with a signed proof URL.
//
// [id] = enrollment UUID (enrollment_id in the StudentRow type)

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const { data: row, error } = await supabase
    .from("enrollments")
    .select(
      `
      *,
      classes (
        level,
        fee_mmk,
        intakes ( name )
      )
    `,
    )
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as { data: EnrollmentJoined | null; error: unknown };

  if (error || !row) return notFound("Enrollment");

  // Fetch most recent payment (if any)
  const { data: payment } = await supabase
    .from("payments")
    .select("*")
    .eq("enrollment_id", row.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single() as { data: Payment | null; error: unknown };

  // Generate signed URL for proof image
  let proof_signed_url: string | null = null;
  if (payment?.proof_image_url) {
    const adminClient = createAdminClient();
    const { data: signed } = await adminClient.storage
      .from(PROOF_BUCKET)
      .createSignedUrl(payment.proof_image_url, SIGNED_URL_EXPIRES_IN);
    proof_signed_url = signed?.signedUrl ?? null;
  }

  // ── Cart enrollment: fetch items + intake from enrollment_items ──
  let cartItems: { class_level: string; quantity: number; fee_mmk: number; subtotal_mmk: number }[] | null = null;
  let cartIntakeName: string | null = null;
  let cartIntakeId: string | null = null;
  let cartTotalFee: number | null = null;

  if (row.class_id === null) {
    const { data: items } = await supabase
      .from("enrollment_items")
      .select("quantity, fee_mmk, classes(level, intake_id, intakes(name))")
      .eq("enrollment_id", row.id) as {
      data: { quantity: number; fee_mmk: number; classes: { level: string; intake_id: string; intakes: { name: string } | null } | null }[] | null;
      error: unknown;
    };

    if (items && items.length > 0) {
      cartItems = items.map((i) => ({
        class_level: i.classes?.level ?? "Unknown",
        quantity: i.quantity,
        fee_mmk: i.fee_mmk,
        subtotal_mmk: i.fee_mmk * i.quantity,
      }));
      cartTotalFee = cartItems.reduce((sum, i) => sum + i.subtotal_mmk, 0);
      cartIntakeName = items[0]?.classes?.intakes?.name ?? null;
      cartIntakeId = items[0]?.classes?.intake_id ?? null;
    }
  }

  // Fetch form field definitions for this enrollment's intake
  const classId = row.class_id;
  const intakeId = classId
    ? await (async () => {
        const { data: cls } = await supabase
          .from("classes")
          .select("intake_id")
          .eq("id", classId)
          .single() as { data: { intake_id: string } | null; error: unknown };
        return cls?.intake_id ?? null;
      })()
    : cartIntakeId;

  let formFieldDefs: { field_key: string; field_label: string; field_type: string }[] = [];
  if (intakeId) {
    const { data: fields } = await supabase
      .from("intake_form_fields")
      .select("field_key, field_label, field_type")
      .eq("intake_id", intakeId)
      .order("sort_order", { ascending: true }) as {
      data: typeof formFieldDefs | null;
      error: unknown;
    };
    formFieldDefs = fields ?? [];
  }

  // For cart: join class levels; for single: use class join
  const classLevel = cartItems
    ? cartItems.map((i) => i.class_level).join(", ")
    : (row.classes?.level ?? null);

  const intakeName = row.classes?.intakes?.name ?? cartIntakeName;

  const feeMmk = cartTotalFee ?? (row.classes?.fee_mmk != null
    ? row.classes.fee_mmk * (row.quantity ?? 1)
    : null);

  return NextResponse.json({
    enrollment_id:   row.id,
    enrollment_ref:  row.enrollment_ref,
    student_name_en: row.student_name_en,
    student_name_mm: row.student_name_mm ?? null,
    nrc_number:      row.nrc_number ?? null,
    phone:           row.phone,
    email:           row.email ?? null,
    form_data:       (row as unknown as Record<string, unknown>).form_data ?? {},
    form_fields:     formFieldDefs,
    status:          row.status,
    enrolled_at:     row.enrolled_at,
    class_level:     classLevel,
    intake_name:     intakeName,
    fee_mmk:         feeMmk,
    items:           cartItems,
    payment: payment
      ? {
          id:               payment.id,
          status:           payment.status,
          amount_mmk:       payment.amount_mmk,
          bank_reference:   payment.bank_reference ?? null,
          submitted_at:     payment.created_at,
          verified_at:      payment.verified_at ?? null,
          proof_signed_url,
        }
      : null,
  });
}
