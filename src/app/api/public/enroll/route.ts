import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatMMK, formatMMKSimple } from "@/lib/utils";
import { sendEmail, enrollmentConfirmationEmail } from "@/lib/email";
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

  const { class_id, form_data, idempotency_key } = body as Record<string, unknown>;

  // ── Validate class_id ─────────────────────────────────────────
  if (!class_id || typeof class_id !== "string" || !UUID_RE.test(class_id)) {
    return NextResponse.json(
      { error: "Validation Error", messages: ["class_id must be a valid UUID."] },
      { status: 400 },
    );
  }

  // ── Call the atomic Postgres transaction (seat reservation) ───
  const supabase = createAdminClient();

  const idemKey = typeof idempotency_key === "string" ? idempotency_key : null;

  const { data: result, error: rpcError } = await supabase.rpc(
    "submit_enrollment",
    { p_class_id: class_id, p_idempotency_key: idemKey } as never,
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

  // Fetch field definitions to check types before legacy mapping + email
  let fieldTypeMap = new Map<string, string>();
  if (fd) {
    const { data: classRow } = await supabase
      .from("classes")
      .select("intake_id")
      .eq("id", class_id)
      .single() as { data: { intake_id: string } | null; error: unknown };

    const { data: fieldDefs } = await supabase
      .from("intake_form_fields")
      .select("field_key, field_type")
      .eq("intake_id", classRow?.intake_id ?? "") as { data: { field_key: string; field_type: string }[] | null; error: unknown };

    fieldTypeMap = new Map((fieldDefs ?? []).map((f) => [f.field_key, f.field_type]));

    const updatePayload: Record<string, unknown> = { form_data: fd };

    // Best-effort mapping: only populate legacy columns when field type matches expectations
    if (fd.name_en && fieldTypeMap.get("name_en") === "text")
      updatePayload.student_name_en = fd.name_en.trim();
    if (fd.name_mm && fieldTypeMap.get("name_mm") === "text")
      updatePayload.student_name_mm = fd.name_mm.trim();
    if (fd.phone && (fieldTypeMap.get("phone") === "phone" || fieldTypeMap.get("phone") === "text"))
      updatePayload.phone = fd.phone.trim();
    if (fd.email && fieldTypeMap.get("email") === "text")
      updatePayload.email = fd.email.trim();
    if (fd.nrc && fieldTypeMap.get("nrc") === "text")
      updatePayload.nrc_number = fd.nrc.trim();

    await supabase
      .from("enrollments")
      .update(updatePayload as never)
      .eq("id", payload.enrollment_id);
  }

  // ── Send confirmation email (best-effort, non-blocking) ──────
  // Only send if email field is actually a text field (not repurposed to file/etc.)
  if (fd?.email && fieldTypeMap.get("email") === "text") {
    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const baseUrl = `${proto}://${host}`;

    const emailData = enrollmentConfirmationEmail({
      studentName: fd.name_en?.trim() || "Student",
      enrollmentRef: payload.enrollment_ref,
      classLevel: payload.class_level,
      feeMmk: payload.fee_mmk,
      feeFormatted: formatMMKSimple(payload.fee_mmk),
      paymentUrl: `${baseUrl}/enroll/payment/${payload.enrollment_ref}`,
      statusUrl: `${baseUrl}/status?ref=${payload.enrollment_ref}`,
    });

    sendEmail({ to: fd.email.trim(), ...emailData }).catch((err) => {
      console.error("[enroll] Email send failed:", err);
    });
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
