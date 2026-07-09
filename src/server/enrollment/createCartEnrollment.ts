import { createAdminClient } from "@/lib/supabase/admin";
import { buildEnrollmentUpdatePayload, fetchFieldTypeMap } from "./formDataMapper";
import type { SubmitCartEnrollmentResult } from "@/types/database";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CartItem {
  class_id: string;
  quantity: number;
}

export interface CartEnrollmentInput {
  items: CartItem[];
  form_data?: Record<string, string> | null;
  messenger_psid?: string | null;
}

// Use Extract to narrow to the success branch
export type SubmitCartEnrollmentSuccess = Extract<SubmitCartEnrollmentResult, { success: true }>;

export interface CartEnrollmentSuccess {
  ok: true;
  result: SubmitCartEnrollmentSuccess;
}

export interface CartEnrollmentError {
  ok: false;
  status: number;
  error: string;
  message: string;
  extra?: Record<string, unknown>;
}

export type CartEnrollmentOutcome = CartEnrollmentSuccess | CartEnrollmentError;

/**
 * Orchestrates cart (multi-item) enrollment:
 * 1. Validates items array (non-empty, each class_id is a valid UUID)
 * 2. Calls submit_cart_enrollment RPC (atomic seat reservation for all items)
 * 3. Updates enrollment with form_data + legacy columns
 *
 * Does NOT send emails — caller handles notifications.
 */
export async function createCartEnrollment(
  input: CartEnrollmentInput,
): Promise<CartEnrollmentOutcome> {
  const { items, form_data, messenger_psid } = input;

  // ── Validate items ────────────────────────────────────────────
  if (!Array.isArray(items) || items.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Validation Error",
      message: "Cart must have at least one item.",
    };
  }

  const validatedItems: CartItem[] = [];
  for (const item of items) {
    if (!item.class_id || !UUID_RE.test(item.class_id)) {
      return {
        ok: false,
        status: 400,
        error: "Validation Error",
        message: "Each item must have a valid class_id UUID.",
      };
    }
    const qty = typeof item.quantity === "number" && item.quantity >= 1 ? Math.floor(item.quantity) : 1;
    validatedItems.push({ class_id: item.class_id, quantity: qty });
  }

  const supabase = createAdminClient();

  const { data: result, error: rpcError } = await supabase.rpc(
    "submit_cart_enrollment",
    { p_items: validatedItems } as never,
  );

  if (rpcError) {
    console.error("[createCartEnrollment] RPC error:", rpcError.message);
    return {
      ok: false,
      status: 500,
      error: "Internal Server Error",
      message: "Enrollment failed. Please try again.",
    };
  }

  const payload = result as SubmitCartEnrollmentResult;

  if (!payload.success) {
    return mapCartEnrollmentError(payload);
  }

  const successPayload = payload as SubmitCartEnrollmentSuccess;

  // ── Update enrollment with form_data + legacy columns ─────────
  const fd = form_data && typeof form_data === "object" ? form_data : null;
  if (fd) {
    const firstClassId = successPayload.items[0]?.class_id;
    let fieldTypeMap = new Map<string, string>();

    if (firstClassId) {
      const { data: classRow } = await supabase
        .from("classes")
        .select("intake_id")
        .eq("id", firstClassId)
        .single() as { data: { intake_id: string } | null; error: unknown };

      if (classRow?.intake_id) {
        fieldTypeMap = await fetchFieldTypeMap(supabase, classRow.intake_id);
      }
    }

    const updatePayload = buildEnrollmentUpdatePayload(fd, fieldTypeMap, messenger_psid);

    await supabase
      .from("enrollments")
      .update(updatePayload as never)
      .eq("id", successPayload.enrollment_id);
  }

  return { ok: true, result: successPayload };
}

function mapCartEnrollmentError(payload: SubmitCartEnrollmentResult): CartEnrollmentError {
  const levelHint = payload.class_level ? ` (${payload.class_level})` : "";
  switch (payload.error) {
    case "EMPTY_CART":
      return { ok: false, status: 400, error: "Validation Error", message: "Cart is empty." };
    case "CLASS_NOT_FOUND":
      return {
        ok: false,
        status: 404,
        error: "Not Found",
        message: `Ticket type not found${levelHint}.`,
      };
    case "CLASS_NOT_OPEN":
      return {
        ok: false,
        status: 409,
        error: "Ticket Unavailable",
        message: `${payload.class_level} is no longer available.`,
      };
    case "NOT_ENOUGH_SEATS":
      return {
        ok: false,
        status: 409,
        error: "Not Enough Seats",
        message: `Only ${payload.seat_remaining} ticket(s) remaining for ${payload.class_level}.`,
        extra: { seat_remaining: payload.seat_remaining },
      };
    case "EXCEEDS_MAX_TICKETS":
      return {
        ok: false,
        status: 409,
        error: "Exceeds Limit",
        message: `Maximum ${payload.max} ticket(s) per person for ${payload.class_level}.`,
      };
    case "ENROLLMENT_NOT_OPEN":
      return {
        ok: false,
        status: 409,
        error: "Enrollment Not Open",
        message: `Ticket sales for ${payload.class_level} have not opened yet.`,
      };
    case "ENROLLMENT_CLOSED":
      return {
        ok: false,
        status: 409,
        error: "Enrollment Closed",
        message: `Ticket sales for ${payload.class_level} have closed.`,
      };
    default:
      console.error("[createCartEnrollment] DB error:", payload.detail);
      return {
        ok: false,
        status: 500,
        error: "Internal Server Error",
        message: "Enrollment failed. Please try again.",
      };
  }
}
