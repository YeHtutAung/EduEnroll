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

  return NextResponse.json({
    enrollment_id:   row.id,
    enrollment_ref:  row.enrollment_ref,
    student_name_en: row.student_name_en,
    student_name_mm: row.student_name_mm ?? null,
    nrc_number:      row.nrc_number ?? null,
    phone:           row.phone,
    email:           row.email ?? null,
    status:          row.status,
    enrolled_at:     row.enrolled_at,
    class_level:     row.classes?.level ?? null,
    intake_name:     row.classes?.intakes?.name ?? null,
    fee_mmk:         row.classes?.fee_mmk ?? null,
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
