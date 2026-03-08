import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatMMK } from "@/lib/utils";
import type { BankAccount, SubmitEnrollmentResult } from "@/types/database";

// ─── Validation helpers ───────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── POST /api/public/enroll ──────────────────────────────────────────────────
// Public — no authentication required.
//
// 1. Calls submit_enrollment(p_class_id) to atomically reserve a seat.
// 2. Updates the enrollment row with form_data + best-effort legacy columns.
//
// Request body:
// {
//   class_id:   string            (UUID, required)
//   form_data?: Record<string, string>  (dynamic form fields)
// }

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── Parse body ────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const { class_id, form_data } = body as Record<string, unknown>;

  // ── Validate class_id ─────────────────────────────────────────
  if (!class_id || typeof class_id !== "string" || !UUID_RE.test(class_id)) {
    return NextResponse.json(
      { error: "Validation Error", messages: ["class_id must be a valid UUID."] },
      { status: 400 },
    );
  }

  // ── Call the atomic Postgres transaction (seat reservation) ───
  const supabase = createAdminClient();

  const { data: result, error: rpcError } = await supabase.rpc(
    "submit_enrollment",
    { p_class_id: class_id } as never,
  );

  if (rpcError) {
    console.error("[enroll] RPC error:", rpcError.message);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Enrollment failed. Please try again." },
      { status: 500 },
    );
  }

  const payload = result as SubmitEnrollmentResult;

  // ── Handle business-logic errors from the DB function ─────────
  if (!payload.success) {
    switch (payload.error) {
      case "CLASS_NOT_FOUND":
        return NextResponse.json(
          { error: "Not Found", message: "Class not found." },
          { status: 404 },
        );
      case "CLASS_NOT_OPEN":
        return NextResponse.json(
          {
            error:   "Class Unavailable",
            message: "This class is no longer accepting enrollments.",
            message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းမှု ပိတ်သိမ်းပြီးဖြစ်သည်။",
          },
          { status: 409 },
        );
      case "CLASS_FULL":
        return NextResponse.json(
          {
            error:   "Class Full",
            message: "Sorry, this class is now full. Please choose another level.",
            message_mm: "ဝမ်းနည်းပါသည်။ ဤသင်တန်းတွင် နေရာပြည့်သွားပြီဖြစ်သည်။ အခြားအဆင့်ကို ရွေးချယ်ပါ။",
          },
          { status: 409 },
        );
      case "ENROLLMENT_NOT_OPEN":
        return NextResponse.json(
          {
            error:   "Enrollment Not Open",
            message: "Enrollment for this class has not opened yet.",
            message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် မရောက်သေးပါ။",
          },
          { status: 409 },
        );
      case "ENROLLMENT_CLOSED":
        return NextResponse.json(
          {
            error:   "Enrollment Closed",
            message: "Enrollment for this class has closed.",
            message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် ကုန်ဆုံးသွားပြီဖြစ်သည်။",
          },
          { status: 409 },
        );
      default:
        console.error("[enroll] DB error:", payload.detail);
        return NextResponse.json(
          { error: "Internal Server Error", message: "Enrollment failed. Please try again." },
          { status: 500 },
        );
    }
  }

  // ── Update enrollment with form_data + legacy columns ─────────
  const fd = (form_data && typeof form_data === "object") ? form_data as Record<string, string> : null;

  if (fd) {
    const updatePayload: Record<string, unknown> = { form_data: fd };

    // Best-effort mapping: populate legacy columns from form_data keys
    if (fd.name_en) updatePayload.student_name_en = fd.name_en.trim();
    if (fd.name_mm) updatePayload.student_name_mm = fd.name_mm.trim();
    if (fd.phone)   updatePayload.phone = fd.phone.trim();
    if (fd.email)   updatePayload.email = fd.email.trim();
    if (fd.nrc)     updatePayload.nrc_number = fd.nrc.trim();

    await supabase
      .from("enrollments")
      .update(updatePayload as never)
      .eq("id", payload.enrollment_id);
  }

  // ── Fetch active bank accounts for payment instructions ───────
  const { data: bankAccounts } = await supabase
    .from("bank_accounts")
    .select("bank_name, account_number, account_holder")
    .eq("tenant_id", payload.tenant_id)
    .eq("is_active", true)
    .order("bank_name") as { data: Pick<BankAccount, "bank_name" | "account_number" | "account_holder">[] | null };

  // ── Return success response ───────────────────────────────────
  return NextResponse.json(
    {
      enrollment_ref: payload.enrollment_ref,
      class_level:    payload.class_level,
      fee_mmk:        payload.fee_mmk,
      fee_formatted:  formatMMK(payload.fee_mmk),
      payment: {
        instructions_en:
          `Please transfer ${formatMMK(payload.fee_mmk)} to one of the bank accounts below ` +
          `and quote your enrollment reference "${payload.enrollment_ref}" as the payment remark.`,
        instructions_mm:
          `ကျောင်းလခ ${formatMMK(payload.fee_mmk)} ကို အောက်ပါ ဘဏ်အကောင့်များသို့ လွှဲပြောင်းပေးပြီး ` +
          `"${payload.enrollment_ref}" ကို ငွေလွှဲမှတ်ချက်တွင် ထည့်သွင်းရေးသားပေးပါ။`,
        bank_accounts: bankAccounts ?? [],
      },
    },
    { status: 201 },
  );
}
