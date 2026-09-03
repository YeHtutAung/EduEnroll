import { createAdminClient } from "@/lib/supabase/admin";
import { buildEnrollmentUpdatePayload, fetchFieldTypeMap } from "./formDataMapper";
import type { SubmitEnrollmentResult } from "@/types/database";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SingleEnrollmentInput {
  class_id: string;
  form_data?: Record<string, string> | null;
  idempotency_key?: string | null;
  quantity?: number;
  messenger_psid?: string | null;
  /** SHA-256 hash of the raw priority-access token, or null if none was presented. */
  priority_token_hash?: string | null;
}

// Use Extract to narrow to the success branch
export type SubmitEnrollmentSuccess = Extract<SubmitEnrollmentResult, { success: true }>;

export interface SingleEnrollmentSuccess {
  ok: true;
  result: SubmitEnrollmentSuccess;
}

export interface SingleEnrollmentError {
  ok: false;
  status: number;
  error: string;
  message: string;
  message_mm?: string;
  extra?: Record<string, unknown>;
}

export type SingleEnrollmentOutcome = SingleEnrollmentSuccess | SingleEnrollmentError;

/**
 * Orchestrates single-class enrollment:
 * 1. Validates class_id
 * 2. Calls submit_enrollment RPC (atomic seat reservation)
 * 3. Updates enrollment with form_data + legacy columns
 *
 * Does NOT send emails — caller handles notifications.
 */
export async function createEnrollment(
  input: SingleEnrollmentInput,
): Promise<SingleEnrollmentOutcome> {
  const { class_id, form_data, idempotency_key, quantity, messenger_psid, priority_token_hash } = input;

  if (!class_id || !UUID_RE.test(class_id)) {
    return { ok: false, status: 400, error: "Validation Error", message: "class_id must be a valid UUID." };
  }

  const supabase = createAdminClient();
  const idemKey = typeof idempotency_key === "string" ? idempotency_key : null;
  const qty = typeof quantity === "number" && quantity >= 1 ? Math.floor(quantity) : 1;
  const priorityTokenHash =
    typeof priority_token_hash === "string" && priority_token_hash.length > 0 ? priority_token_hash : null;

  const { data: result, error: rpcError } = await supabase.rpc(
    "submit_enrollment",
    {
      p_class_id: class_id,
      p_idempotency_key: idemKey,
      p_quantity: qty,
      p_priority_token_hash: priorityTokenHash,
    } as never,
  );

  if (rpcError) {
    console.error("[createEnrollment] RPC error:", rpcError.message);
    return { ok: false, status: 500, error: "Internal Server Error", message: "Enrollment failed. Please try again." };
  }

  const payload = result as SubmitEnrollmentResult;

  if (!payload.success) {
    return mapEnrollmentError(payload);
  }

  const successPayload = payload as SubmitEnrollmentSuccess;

  const fd = form_data && typeof form_data === "object" ? form_data : null;
  if (fd) {
    const { data: classRow } = await supabase
      .from("classes")
      .select("intake_id")
      .eq("id", class_id)
      .single() as { data: { intake_id: string } | null; error: unknown };

    const fieldTypeMap = classRow?.intake_id
      ? await fetchFieldTypeMap(supabase, classRow.intake_id)
      : new Map<string, string>();

    const updatePayload = buildEnrollmentUpdatePayload(fd, fieldTypeMap, messenger_psid);

    await supabase
      .from("enrollments")
      .update(updatePayload as never)
      .eq("id", successPayload.enrollment_id);
  }

  return { ok: true, result: successPayload };
}

function mapEnrollmentError(payload: Extract<SubmitEnrollmentResult, { success: false }>): SingleEnrollmentError {
  switch (payload.error) {
    case "CLASS_NOT_FOUND":
      return { ok: false, status: 404, error: "Not Found", message: "Class not found." };
    case "CLASS_NOT_OPEN":
      return {
        ok: false, status: 409, error: "Class Unavailable",
        message: "This class is no longer accepting enrollments.",
        message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းမှု ပိတ်သိမ်းပြီးဖြစ်သည်။",
      };
    case "CLASS_FULL":
      return {
        ok: false, status: 409, error: "Class Full",
        message: "Sorry, this class is now full. Please choose another level.",
        message_mm: "ဝမ်းနည်းပါသည်။ ဤသင်တန်းတွင် နေရာပြည့်သွားပြီဖြစ်သည်။ အခြားအဆင့်ကို ရွေးချယ်ပါ။",
      };
    case "NOT_ENOUGH_SEATS":
      return {
        ok: false, status: 409, error: "Not Enough Seats",
        message: `Only ${payload.seat_remaining} ticket(s) remaining. Please reduce your quantity.`,
        message_mm: `လက်ကျန်လက်မှတ် ${payload.seat_remaining} ခုသာ ကျန်ပါသည်။ အရေအတွက် လျှော့ပါ။`,
        extra: { seat_remaining: payload.seat_remaining },
      };
    case "EXCEEDS_MAX_TICKETS":
      return {
        ok: false, status: 409, error: "Exceeds Limit",
        message: `Maximum ${payload.max} ticket(s) per person.`,
        message_mm: `တစ်ဦးလျှင် အများဆုံး လက်မှတ် ${payload.max} ခုသာ ဝယ်ယူနိုင်ပါသည်။`,
      };
    case "ENROLLMENT_NOT_OPEN":
      return {
        ok: false, status: 409, error: "Enrollment Not Open",
        message: "Enrollment for this class has not opened yet.",
        message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် မရောက်သေးပါ။",
      };
    case "ENROLLMENT_CLOSED":
      return {
        ok: false, status: 409, error: "Enrollment Closed",
        message: "Enrollment for this class has closed.",
        message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် ကုန်ဆုံးသွားပြီဖြစ်သည်။",
      };
    default:
      console.error("[createEnrollment] DB error:", payload.detail);
      return { ok: false, status: 500, error: "Internal Server Error", message: "Enrollment failed. Please try again." };
  }
}
