import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireOwner, badRequest, notFound } from "@/lib/api";
import type { Intake, IntakeStatus } from "@/types/database";

const VALID_STATUSES: IntakeStatus[] = ["draft", "open", "closed"];

type IntakeResult = { data: Intake | null; error: unknown };

// ─── GET /api/intakes/[id] ────────────────────────────────────────────────────
// Fetch a single intake. RLS ensures only the caller's tenant is visible.

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (params.id === "new") return notFound("Intake");

  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const { data, error } = await supabase
    .from("intakes")
    .select("*")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as IntakeResult;

  if (error || !data) return notFound("Intake");

  return NextResponse.json(data);
}

// ─── PATCH /api/intakes/[id] ──────────────────────────────────────────────────
// Partially update an intake. All body fields are optional.
//
// Allowed fields: name, year, status, hero_image_url, priority_open_at

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (params.id === "new") return notFound("Intake");

  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { name, year, status, hero_image_url, priority_open_at } = body as Record<
    string,
    unknown
  >;

  const update: Partial<Omit<Intake, "id" | "created_at">> = {};

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim() === "") {
      return badRequest("name must be a non-empty string.");
    }
    update.name = name.trim();
  }

  if (year !== undefined) {
    if (typeof year !== "number" || !Number.isInteger(year) || year < 2020 || year > 2100) {
      return badRequest("year must be an integer between 2020 and 2100.");
    }
    update.year = year;
  }

  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status as IntakeStatus)) {
      return badRequest(`status must be one of: ${VALID_STATUSES.join(", ")}.`);
    }
    update.status = status as IntakeStatus;
  }

  if (hero_image_url !== undefined) {
    if (hero_image_url !== null && typeof hero_image_url !== "string") {
      return badRequest("hero_image_url must be a string or null.");
    }
    update.hero_image_url = hero_image_url as string | null;
  }

  // priority_open_at — start of the interest head-start window. Same
  // ISO-string-or-null validation enrollment_open_at gets in
  // src/app/api/classes/[id]/route.ts; null clears the window.
  //
  // `in (body as object)` rather than `!== undefined`, so an explicit null is
  // distinguishable from an absent key — clearing the window has to be possible.
  if ("priority_open_at" in (body as object)) {
    if (priority_open_at !== null && typeof priority_open_at !== "string") {
      return badRequest("priority_open_at must be an ISO 8601 string or null.");
    }
    update.priority_open_at = (priority_open_at as string | null) ?? null;
  }

  if (Object.keys(update).length === 0) {
    return badRequest("No valid fields provided for update.");
  }

  const { data, error } = await supabase
    .from("intakes")
    .update(update as never)
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .select()
    .single() as IntakeResult;

  if (error) {
    // The window's relationship to per-tier sale times spans two tables, so it
    // cannot be a CHECK — it is a trigger, and a trigger failure arrives here
    // as a write error rather than as anything the validation above could have
    // caught. Left alone it would surface to an organiser as a bare "Intake not
    // found", or as a raw P0001. Neither tells them their date is the problem.
    const windowMessage = priorityWindowMessage(error);
    if (windowMessage) return badRequest(windowMessage);
    return notFound("Intake");
  }

  if (!data) return notFound("Intake");

  return NextResponse.json(data);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Recognises the cross-table priority-window trigger
 * (`assert_priority_window_valid`, installed by
 * 20260827120000_event_interest_priority_window.sql) and turns it into
 * something an organiser can act on.
 *
 * Matched on the message text, not on the SQLSTATE: plpgsql's RAISE EXCEPTION
 * defaults to P0001, which is the generic "raised exception" code shared by
 * every hand-written check in the schema. Keying on the code alone would
 * mislabel an unrelated trigger's failure as a bad date. The trigger's message
 * names the column, and that is the discriminator.
 */
function priorityWindowMessage(error: unknown): string | null {
  const message = (error as { message?: string } | null)?.message ?? "";
  if (!message.includes("priority_open_at")) return null;

  return (
    "The priority window must open no later than the earliest ticket tier's " +
    "sale time. Move the priority window earlier, or move that tier's sale " +
    "time later."
  );
}
