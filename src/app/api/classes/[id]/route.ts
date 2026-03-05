import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";
import type { Class, ClassStatus } from "@/types/database";

const VALID_CLASS_STATUSES: ClassStatus[] = ["draft", "open", "full", "closed"];

type ClassResult = { data: Class | null; error: unknown };

// ─── PATCH /api/classes/[id] ──────────────────────────────────────────────────
// Update a class. All fields are optional.
//
// Allowed fields:
//   fee_mmk              — tuition fee in MMK
//   seat_total           — total capacity; seat_remaining is adjusted to preserve taken seats
//   enrollment_open_at   — ISO 8601 datetime (pass null to clear)
//   enrollment_close_at  — ISO 8601 datetime (pass null to clear)
//   status               — draft | open | full | closed

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  // Fetch current class to base seat_remaining adjustments on
  const { data: existing, error: fetchError } = await supabase
    .from("classes")
    .select("*")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as ClassResult;

  if (fetchError || !existing) return notFound("Class");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const {
    fee_mmk,
    seat_total,
    enrollment_open_at,
    enrollment_close_at,
    status,
  } = body as Record<string, unknown>;

  const update: Partial<Omit<Class, "id" | "created_at">> = {};

  // fee_mmk
  if (fee_mmk !== undefined) {
    if (typeof fee_mmk !== "number" || fee_mmk <= 0) {
      return badRequest("fee_mmk must be a positive number.");
    }
    update.fee_mmk = fee_mmk;
  }

  // seat_total — keep taken seats constant, recalculate seat_remaining
  if (seat_total !== undefined) {
    if (typeof seat_total !== "number" || !Number.isInteger(seat_total) || seat_total < 1) {
      return badRequest("seat_total must be a positive integer.");
    }
    const takenSeats = existing.seat_total - existing.seat_remaining;
    update.seat_total = seat_total;
    update.seat_remaining = Math.max(0, seat_total - takenSeats);
  }

  // enrollment_open_at — null is allowed to clear the value
  if ("enrollment_open_at" in (body as object)) {
    if (enrollment_open_at !== null && typeof enrollment_open_at !== "string") {
      return badRequest("enrollment_open_at must be an ISO 8601 string or null.");
    }
    update.enrollment_open_at = (enrollment_open_at as string | null) ?? null;
  }

  // enrollment_close_at — null is allowed to clear the value
  if ("enrollment_close_at" in (body as object)) {
    if (enrollment_close_at !== null && typeof enrollment_close_at !== "string") {
      return badRequest("enrollment_close_at must be an ISO 8601 string or null.");
    }
    update.enrollment_close_at = (enrollment_close_at as string | null) ?? null;
  }

  // status
  if (status !== undefined) {
    if (!VALID_CLASS_STATUSES.includes(status as ClassStatus)) {
      return badRequest(`status must be one of: ${VALID_CLASS_STATUSES.join(", ")}.`);
    }
    update.status = status as ClassStatus;
  }

  if (Object.keys(update).length === 0) {
    return badRequest("No valid fields provided for update.");
  }

  const { data, error } = await supabase
    .from("classes")
    .update(update as never)
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .select()
    .single() as ClassResult;

  if (error || !data) return notFound("Class");

  return NextResponse.json(data);
}
