import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";
import type { Class, ClassMode, ClassStatus } from "@/types/database";

const VALID_CLASS_STATUSES: ClassStatus[] = ["draft", "open", "full", "closed"];
const VALID_CLASS_MODES: ClassMode[] = ["online", "offline"];

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
    mode,
    event_date,
    start_time,
    end_time,
    venue,
    image_url,
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

  // mode
  if (mode !== undefined) {
    if (!VALID_CLASS_MODES.includes(mode as ClassMode)) {
      return badRequest(`mode must be one of: ${VALID_CLASS_MODES.join(", ")}.`);
    }
    update.mode = mode as ClassMode;
  }

  // event_date — null is allowed to clear the value
  if ("event_date" in (body as object)) {
    if (event_date !== null && typeof event_date !== "string") {
      return badRequest("event_date must be a date string or null.");
    }
    update.event_date = (event_date as string | null) ?? null;
  }

  // start_time
  if ("start_time" in (body as object)) {
    if (start_time !== null && typeof start_time !== "string") {
      return badRequest("start_time must be a time string or null.");
    }
    update.start_time = (start_time as string | null) ?? null;
  }

  // end_time
  if ("end_time" in (body as object)) {
    if (end_time !== null && typeof end_time !== "string") {
      return badRequest("end_time must be a time string or null.");
    }
    update.end_time = (end_time as string | null) ?? null;
  }

  // venue
  if ("venue" in (body as object)) {
    if (venue !== null && typeof venue !== "string") {
      return badRequest("venue must be a string or null.");
    }
    update.venue = (venue as string | null) ?? null;
  }

  // image_url
  if ("image_url" in (body as object)) {
    if (image_url !== null && typeof image_url !== "string") {
      return badRequest("image_url must be a string or null.");
    }
    update.image_url = (image_url as string | null) ?? null;
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
