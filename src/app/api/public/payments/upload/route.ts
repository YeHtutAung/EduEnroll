import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatMMK } from "@/lib/utils";
import type { Enrollment, Class, Payment } from "@/types/database";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE   = 5 * 1024 * 1024; // 5 MB per file
const MAX_FILES       = 5;
const ALLOWED_TYPES   = ["image/jpeg", "image/png", "image/webp"] as const;
const STORAGE_BUCKET  = "payment-proofs";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};

// ─── Statuses that accept uploads ─────────────────────────────────────────────

const UPLOADABLE_STATUSES = ["pending_payment", "partial_payment"] as const;

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
//   proof_image      File[]   (required)  1–5 images, JPEG / PNG / WebP, max 5 MB each
//
// For partial_payment re-uploads, appends new images to existing proof_image_urls.

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
  const proofImages   = formData.getAll("proof_image");

  if (!enrollmentRef || typeof enrollmentRef !== "string" || enrollmentRef.trim() === "") {
    return NextResponse.json(
      { error: "Bad Request", message: "enrollment_ref is required." },
      { status: 400 },
    );
  }

  // Filter to actual File objects
  const files = proofImages.filter((f): f is File => f instanceof File && f.size > 0);

  if (files.length === 0) {
    return NextResponse.json(
      { error: "Bad Request", message: "At least one proof_image file is required." },
      { status: 400 },
    );
  }

  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { error: "Bad Request", message: `Maximum ${MAX_FILES} images allowed.` },
      { status: 400 },
    );
  }

  // ── 2. Validate all files ──────────────────────────────────────
  for (const file of files) {
    if (!ALLOWED_TYPES.includes(file.type as (typeof ALLOWED_TYPES)[number])) {
      return NextResponse.json(
        {
          error: "Bad Request",
          message: `File type '${file.type}' is not allowed. Accepted: jpeg, png, webp.`,
        },
        { status: 400 },
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "Bad Request", message: "Each file must not exceed 5 MB." },
        { status: 400 },
      );
    }
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

  // ── 4. Guard: only accept uploads for pending_payment or partial_payment
  if (!UPLOADABLE_STATUSES.includes(enrollment.status as typeof UPLOADABLE_STATUSES[number])) {
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

  // ── 5. Upload all files to storage ─────────────────────────────
  const uploadedPaths: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext         = MIME_TO_EXT[file.type] ?? "jpg";
    const timestamp   = Date.now() + i; // ensure unique timestamps
    const storagePath = `${enrollment.tenant_id}/${enrollmentRef.trim()}/${timestamp}.${ext}`;

    const fileBuffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      // Clean up already-uploaded files on failure
      if (uploadedPaths.length > 0) {
        await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths);
      }
      console.error("[upload] Storage error:", uploadError.message);
      return NextResponse.json(
        { error: "Upload Failed", message: "Could not upload image. Please try again." },
        { status: 500 },
      );
    }

    uploadedPaths.push(storagePath);
  }

  // ── 6. Check for existing payment (partial_payment re-upload case) ──
  const isReUpload = enrollment.status === "partial_payment";
  let existingPayment: Payment | null = null;

  if (isReUpload) {
    const { data: ep } = await supabase
      .from("payments")
      .select("*")
      .eq("enrollment_id", enrollment.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single() as { data: Payment | null; error: unknown };
    existingPayment = ep;
  }

  if (isReUpload && existingPayment) {
    // Append new images to existing proof_image_urls and reset status to pending
    const existingUrls = existingPayment.proof_image_urls ?? [];
    const allUrls = [...existingUrls, ...uploadedPaths];

    const { error: updateError } = await supabase
      .from("payments")
      .update({
        proof_image_urls: allUrls,
        proof_image_url: allUrls[0], // keep legacy field in sync
        status: "pending",
      } as never)
      .eq("id", existingPayment.id);

    if (updateError) {
      await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths);
      console.error("[upload] Payment update error:", (updateError as { message: string })?.message);
      return NextResponse.json(
        { error: "Internal Server Error", message: "Failed to update payment. Please try again." },
        { status: 500 },
      );
    }

    // Advance enrollment status back to payment_submitted
    await supabase
      .from("enrollments")
      .update({ status: "payment_submitted" } as never)
      .eq("id", enrollment.id);

    return NextResponse.json(
      {
        payment_id:       existingPayment.id,
        enrollment_ref:   enrollmentRef.trim(),
        amount_mmk:       existingPayment.amount_mmk,
        amount_formatted: formatMMK(existingPayment.amount_mmk),
        proof_count:      allUrls.length,
        status:           "pending",
        message_en:       "Additional payment proof submitted. Our team will review it shortly.",
        message_mm:       "နောက်ထပ်ငွေပေးချေမှုအထောက်အထား တင်သွင်းပြီးပါပြီ။ မကြာမီ စစ်ဆေးပေးပါမည်။",
      },
      { status: 201 },
    );
  }

  // ── 7. Create new payment record ───────────────────────────────
  const { data: payment, error: paymentError } = await supabase
    .from("payments")
    .insert({
      enrollment_id:    enrollment.id,
      tenant_id:        enrollment.tenant_id,
      amount_mmk:       enrollment.classes.fee_mmk,
      proof_image_url:  uploadedPaths[0],   // legacy field — first image
      proof_image_urls: uploadedPaths,       // all images
      status:           "pending",
    } as never)
    .select()
    .single() as PaymentResult;

  if (paymentError || !payment) {
    // Best-effort: remove the orphaned uploads if the DB insert fails
    await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths);
    console.error("[upload] Payment insert error:", (paymentError as { message: string })?.message);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to record payment. Please try again." },
      { status: 500 },
    );
  }

  // ── 8. Return success ─────────────────────────────────────────
  return NextResponse.json(
    {
      payment_id:       payment.id,
      enrollment_ref:   enrollmentRef.trim(),
      amount_mmk:       enrollment.classes.fee_mmk,
      amount_formatted: formatMMK(enrollment.classes.fee_mmk),
      proof_count:      uploadedPaths.length,
      status:           "pending",
      message_en:       "Payment proof submitted. Our team will verify it within 1 business day.",
      message_mm:       "ငွေပေးချေမှုအထောက်အထား တင်သွင်းပြီးပါပြီ။ အလုပ်ဆောင်ရွက်သောနေ့ ၁ ရက်အတွင်း စစ်ဆေးအတည်ပြုပေးမည်ဖြစ်သည်။",
    },
    { status: 201 },
  );
}
