import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatMMK } from "@/lib/utils";
import type { Enrollment, Class, Payment } from "@/types/database";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE   = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES   = ["image/jpeg", "image/png", "image/webp"] as const;
const STORAGE_BUCKET  = "payment-proofs";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};

// ─── Joined row type for the enrollment + class lookup ────────────────────────

interface EnrollmentWithClass extends Enrollment {
  classes: Pick<Class, "id" | "fee_mmk"> | null;
}

type EnrollmentResult = { data: EnrollmentWithClass | null; error: unknown };
type PaymentResult    = { data: Payment             | null; error: unknown };

// ─── POST /api/public/payments/upload ─────────────────────────────────────────
// Public — no authentication required.
//
// Accepts multipart/form-data:
//   enrollment_ref   string   (required)  e.g. "NM-2026-00042"
//   proof_image      File     (required)  JPEG / PNG / WebP, max 5 MB
//
// Flow:
//   1. Validate form fields
//   2. Look up enrollment — must exist with status='pending_payment'
//   3. Validate file type and size
//   4. Upload to Storage: payment-proofs/{tenant_id}/{enrollment_ref}/{ts}.ext
//   5. INSERT payment record (status='pending', amount_mmk from class fee)
//   6. Enrollment status is advanced to 'payment_submitted' automatically
//      by the trg_payments_sync_enrollment trigger in 006_create_payments.sql
//   7. Return payment id + confirmation

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── 1. Parse multipart form data ──────────────────────────────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Expected multipart/form-data." },
      { status: 400 },
    );
  }

  const enrollmentRef = formData.get("enrollment_ref");
  const proofImage    = formData.get("proof_image");

  if (!enrollmentRef || typeof enrollmentRef !== "string" || enrollmentRef.trim() === "") {
    return NextResponse.json(
      { error: "Bad Request", message: "enrollment_ref is required." },
      { status: 400 },
    );
  }
  if (!proofImage || !(proofImage instanceof File)) {
    return NextResponse.json(
      { error: "Bad Request", message: "proof_image file is required." },
      { status: 400 },
    );
  }

  // ── 2. Validate file ──────────────────────────────────────────
  if (!ALLOWED_TYPES.includes(proofImage.type as (typeof ALLOWED_TYPES)[number])) {
    return NextResponse.json(
      {
        error: "Bad Request",
        message: `File type '${proofImage.type}' is not allowed. Accepted: jpeg, png, webp.`,
      },
      { status: 400 },
    );
  }
  if (proofImage.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "Bad Request", message: "File size must not exceed 5 MB." },
      { status: 400 },
    );
  }
  if (proofImage.size === 0) {
    return NextResponse.json(
      { error: "Bad Request", message: "Uploaded file is empty." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // ── 3. Look up enrollment with class fee ──────────────────────
  const { data: enrollment, error: enrollmentError } = await supabase
    .from("enrollments")
    .select("*, classes(id, fee_mmk)")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single() as EnrollmentResult;

  if (enrollmentError || !enrollment) {
    return NextResponse.json(
      { error: "Not Found", message: "Enrollment not found for this reference." },
      { status: 404 },
    );
  }

  // ── 4. Guard: only accept uploads for pending_payment enrollments
  if (enrollment.status !== "pending_payment") {
    const STATUS_MESSAGES: Record<string, { en: string; mm: string }> = {
      payment_submitted: {
        en: "Payment proof has already been submitted for this enrollment.",
        mm: "ဤစာရင်းသွင်းမှုအတွက် ငွေပေးချေမှုအထောက်အထား တင်သွင်းပြီးဖြစ်သည်။",
      },
      confirmed: {
        en: "This enrollment has already been confirmed.",
        mm: "ဤစာရင်းသွင်းမှုကို အတည်ပြုပြီးဖြစ်သည်။",
      },
      rejected: {
        en: "This enrollment has been rejected.",
        mm: "ဤစာရင်းသွင်းမှုကို ငြင်းဆိုထားသည်။",
      },
    };
    const msg = STATUS_MESSAGES[enrollment.status] ?? {
      en: "This enrollment cannot accept a payment upload at this time.",
      mm: "ဤစာရင်းသွင်းမှုအတွက် ယခုအချိန်တွင် ငွေပေးချေမှု တင်သွင်းလက်မခံနိုင်ပါ။",
    };
    return NextResponse.json(
      { error: "Conflict", message: msg.en, message_mm: msg.mm },
      { status: 409 },
    );
  }

  if (!enrollment.classes) {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Class data not found." },
      { status: 500 },
    );
  }

  // ── 5. Build storage path and upload ─────────────────────────
  const ext         = MIME_TO_EXT[proofImage.type] ?? "jpg";
  const timestamp   = Date.now();
  const storagePath = `${enrollment.tenant_id}/${enrollmentRef.trim()}/${timestamp}.${ext}`;

  const fileBuffer = Buffer.from(await proofImage.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: proofImage.type,
      upsert: false,
    });

  if (uploadError) {
    console.error("[upload] Storage error:", uploadError.message);
    return NextResponse.json(
      { error: "Upload Failed", message: "Could not upload image. Please try again." },
      { status: 500 },
    );
  }

  // ── 6. Create payment record ──────────────────────────────────
  // The trg_payments_sync_enrollment trigger (006_create_payments.sql)
  // automatically advances enrollment.status → 'payment_submitted'
  // when a payment with status='pending' is inserted.
  const { data: payment, error: paymentError } = await supabase
    .from("payments")
    .insert({
      enrollment_id:   enrollment.id,
      tenant_id:       enrollment.tenant_id,
      amount_mmk:      enrollment.classes.fee_mmk,
      proof_image_url: storagePath,
      status:          "pending",
    } as never)
    .select()
    .single() as PaymentResult;

  if (paymentError || !payment) {
    // Best-effort: remove the orphaned upload if the DB insert fails
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
    console.error("[upload] Payment insert error:", (paymentError as { message: string })?.message);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to record payment. Please try again." },
      { status: 500 },
    );
  }

  // ── 7. Return success ─────────────────────────────────────────
  return NextResponse.json(
    {
      payment_id:       payment.id,
      enrollment_ref:   enrollmentRef.trim(),
      amount_mmk:       enrollment.classes.fee_mmk,
      amount_formatted: formatMMK(enrollment.classes.fee_mmk),
      status:           "pending",
      message_en:       "Payment proof submitted. Our team will verify it within 1 business day.",
      message_mm:       "ငွေပေးချေမှုအထောက်အထား တင်သွင်းပြီးပါပြီ။ အလုပ်ဆောင်ရွက်သောနေ့ ၁ ရက်အတွင်း စစ်ဆေးအတည်ပြုပေးမည်ဖြစ်သည်။",
    },
    { status: 201 },
  );
}
