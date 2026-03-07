import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatMMK } from "@/lib/utils";
import type { BankAccount, SubmitEnrollmentResult } from "@/types/database";

// ─── Validation helpers ───────────────────────────────────────────────────────

const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Myanmar mobile: 09xxxxxxxxx or +959xxxxxxxxx (9-10 digits after country prefix)
const MM_PHONE_RE = /^(?:\+?95|0)(9\d{7,9})$/;

function isValidMyanmarPhone(phone: string): boolean {
  return MM_PHONE_RE.test(phone.replace(/[\s\-().]/g, ""));
}

// ─── POST /api/public/enroll ──────────────────────────────────────────────────
// Public — no authentication required.
//
// Submits a new enrollment for a Nihon Moment class.
// On success, reserves a seat atomically via the submit_enrollment()
// Postgres function (SELECT FOR UPDATE transaction).
//
// Request body:
// {
//   class_id:          string   (UUID, required)
//   student_name_en:   string   (required — English name)
//   student_name_mm?:  string   (optional — Myanmar script name)
//   nrc_number?:       string   (optional — Myanmar NRC card number)
//   phone:             string   (required — Myanmar format 09-xxxxxxxxx)
//   email?:            string   (optional)
// }
//
// Success 201:
// {
//   enrollment_ref:  "NM-2026-00042"
//   class_level:     "N5"
//   fee_mmk:         300000
//   fee_formatted:   "၃၀၀,၀၀၀ MMK"
//   payment: {
//     instructions_en: string
//     instructions_mm: string
//     bank_accounts:   BankAccount[]
//   }
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

  const {
    class_id,
    student_name_en,
    student_name_mm,
    nrc_number,
    phone,
    email,
    form_data,
  } = body as Record<string, unknown>;

  // ── Validate required fields ──────────────────────────────────
  const errors: string[] = [];

  if (!class_id || typeof class_id !== "string" || !UUID_RE.test(class_id)) {
    errors.push("class_id must be a valid UUID.");
  }
  if (!student_name_en || typeof student_name_en !== "string" || student_name_en.trim() === "") {
    errors.push("student_name_en is required.");
  }
  if (!phone || typeof phone !== "string") {
    errors.push("phone is required.");
  } else if (!isValidMyanmarPhone(phone)) {
    errors.push("phone must be a valid Myanmar number (09-xxxxxxxxx or +959-xxxxxxxxx).");
  }
  if (email !== undefined && email !== null && email !== "") {
    if (typeof email !== "string" || !EMAIL_RE.test(email)) {
      errors.push("email must be a valid email address.");
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: "Validation Error", messages: errors }, { status: 400 });
  }

  // ── Call the atomic Postgres transaction ──────────────────────
  const supabase = createAdminClient();

  const { data: result, error: rpcError } = await supabase.rpc(
    "submit_enrollment",
    {
      p_class_id:        class_id as string,
      p_student_name_en: (student_name_en as string).trim(),
      p_phone:           (phone          as string).trim(),
      p_student_name_mm: (student_name_mm as string | null | undefined) ?? null,
      p_nrc_number:      (nrc_number     as string | null | undefined) ?? null,
      p_email:           (email          as string | null | undefined) ?? null,
    } as never,
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
      default:
        console.error("[enroll] DB error:", payload.detail);
        return NextResponse.json(
          { error: "Internal Server Error", message: "Enrollment failed. Please try again." },
          { status: 500 },
        );
    }
  }

  // ── Save form_data if provided ───────────────────────────────────
  if (form_data && typeof form_data === "object") {
    await supabase
      .from("enrollments")
      .update({ form_data } as never)
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
