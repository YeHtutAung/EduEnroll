import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireOwner, badRequest, notFound, type AuthContext } from "@/lib/api";
import type { Intake, IntakeStatus } from "@/types/database";
import { EMAIL_TERMS_MAX, normaliseOrganiserTerms, ORGANISER_TERMS_MAX } from "@/lib/legal/terms";
import { validateEventFont } from "@/lib/eventFont";

const VALID_STATUSES: IntakeStatus[] = ["draft", "open", "closed"];

type IntakeResult = { data: Intake | null; error: unknown };

// ─── GET /api/intakes/[id] ────────────────────────────────────────────────────
// Fetch a single intake. RLS ensures only the caller's tenant is visible.
// Adds `has_orders`: whether any order (single or cart) is on the intake's
// classes. The edit form disables the "Account-bound tickets" switch then; the
// database trigger intakes_lock_ticket_protection is the actual control.

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

  const has_orders = await intakeHasOrders(supabase, params.id);
  return NextResponse.json({ ...data, has_orders });
}

// ─── PATCH /api/intakes/[id] ──────────────────────────────────────────────────
// Partially update an intake. All body fields are optional.
//
// Allowed fields: name, year, status, hero_image_url, priority_open_at, organiser_terms,
// email_terms, font_css_url + font_family (together), ticket_protection

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

  const { name, year, status, hero_image_url, priority_open_at, organiser_terms, email_terms, font_css_url, font_family, ticket_protection } = body as Record<
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
    // Parsed, not merely type-checked. An unparseable string reaches Postgres,
    // fails the timestamptz cast, and comes back as a write error — which the
    // handler below reports as "Intake not found", sending an organiser to look
    // for a missing event when the actual problem is the date they typed.
    if (typeof priority_open_at === "string" && Number.isNaN(Date.parse(priority_open_at))) {
      return badRequest("priority_open_at must be a valid ISO 8601 date and time.");
    }
    update.priority_open_at = (priority_open_at as string | null) ?? null;
  }

  // organiser_terms — the organiser's event rules shown to buyers. Explicit
  // null (or blank text) clears them, so the same `in` test as above.
  // Length checked here as well as by the DB constraint, so an organiser gets
  // the limit named instead of a generic write failure.
  if ("organiser_terms" in (body as object)) {
    if (organiser_terms !== null && typeof organiser_terms !== "string") {
      return badRequest("organiser_terms must be a string or null.");
    }
    const normalised = normaliseOrganiserTerms(organiser_terms as string | null);
    if (normalised !== null && normalised.length > ORGANISER_TERMS_MAX) {
      return badRequest(`Event rules must be at most ${ORGANISER_TERMS_MAX} characters.`);
    }
    update.organiser_terms = normalised;
  }

  // email_terms — printed in the confirmation email only, never at checkout.
  // Explicit null (or blank text) clears them.
  if ("email_terms" in (body as object)) {
    if (email_terms !== null && typeof email_terms !== "string") {
      return badRequest("email_terms must be a string or null.");
    }
    const normalised = normaliseOrganiserTerms(email_terms as string | null);
    if (normalised !== null && normalised.length > EMAIL_TERMS_MAX) {
      return badRequest(`Email terms must be at most ${EMAIL_TERMS_MAX} characters.`);
    }
    update.email_terms = normalised;
  }

  // font_css_url + font_family — the event's Adobe Fonts web font. Validated
  // as a pair (see @/lib/eventFont); blank or null in both clears it.
  if ("font_css_url" in (body as object) || "font_family" in (body as object)) {
    const font = validateEventFont(font_css_url, font_family);
    if (!font.ok) return badRequest(font.message);
    update.font_css_url = font.value.font_css_url;
    update.font_family = font.value.font_family;
  }

  // ticket_protection — account-bound tickets (design 3). Owner only, like
  // every field here (requireOwner above). The database refuses a change once
  // the intake has orders, and true unless the QR format is jwt; both are
  // mapped to 409 below.
  if ("ticket_protection" in (body as object)) {
    if (typeof ticket_protection !== "boolean") {
      return badRequest("ticket_protection must be a boolean.");
    }
    update.ticket_protection = ticket_protection;
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
    const protectionMessage = ticketProtectionMessage(error);
    if (protectionMessage) {
      return NextResponse.json({ error: "Conflict", message: protectionMessage }, { status: 409 });
    }
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

/**
 * The two database refusals of the "Account-bound tickets" switch
 * (20261122130000_leaders_phone.sql):
 * - the trigger intakes_lock_ticket_protection raises `ticket_protection_locked`
 *   (P0001) when the intake already has orders;
 * - the CHECK intakes_ticket_protection_needs_jwt (23514) refuses protection
 *   unless the QR format is jwt.
 */
function ticketProtectionMessage(error: unknown): string | null {
  const e = (error ?? {}) as { code?: string; message?: string; details?: string };
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  if (text.includes("ticket_protection_locked")) {
    return "This event already has orders, so account-bound tickets can't be switched.";
  }
  if (e.code === "23514" && text.includes("intakes_ticket_protection_needs_jwt")) {
    return "Account-bound tickets need the signed QR format.";
  }
  return null;
}

/**
 * Whether any order sits on the intake's classes: one enrollments count (single
 * orders) and one enrollment_items count (cart orders), as the trigger checks.
 * A failed count answers true, so the switch is disabled rather than offered.
 */
async function intakeHasOrders(
  supabase: AuthContext["supabase"],
  intakeId: string,
): Promise<boolean> {
  try {
    const [single, cart] = await Promise.all([
      supabase
        .from("enrollments")
        .select("id, classes!inner(intake_id)", { count: "exact", head: true })
        .eq("classes.intake_id", intakeId),
      supabase
        .from("enrollment_items")
        .select("id, classes!inner(intake_id)", { count: "exact", head: true })
        .eq("classes.intake_id", intakeId),
    ]);
    if (single.error || cart.error) return true;
    return (single.count ?? 0) > 0 || (cart.count ?? 0) > 0;
  } catch {
    return true;
  }
}
