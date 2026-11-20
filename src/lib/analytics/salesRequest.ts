import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, badRequest } from "@/lib/api";
import { parseSalesFilters, pickDefaultIntake, type SalesFilters } from "@/lib/analytics/sales";

// Shared auth + filter resolution for the Sales Analytics API routes.
//
// Admin session only: owner, staff (and superadmin acting in a tenant). The
// signed bot (agent) path is refused — it runs on the service-role client, and
// these routes include a buyer contact list.

const ALLOWED_ROLES = new Set(["owner", "staff", "superadmin"]);

export interface SalesRequestContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>;
  intakes: { id: string; name: string }[];
  intake: { id: string; name: string } | null;
  ticketTypes: { id: string; level: string }[];
  filters: SalesFilters;
}

export async function resolveSalesRequest(
  request: Request,
): Promise<SalesRequestContext | NextResponse> {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  if (auth.isAgent || !ALLOWED_ROLES.has(auth.user.role)) {
    return NextResponse.json(
      { error: "Forbidden", message: "Admin access required." },
      { status: 403 },
    );
  }
  const { supabase, tenantId } = auth;

  const parsed = parseSalesFilters(new URL(request.url).searchParams);
  if ("error" in parsed) return badRequest(parsed.error);
  const filters = parsed.filters;

  const { data: intakeRows, error: intakeError } = (await supabase
    .from("intakes")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })) as {
    data: { id: string; name: string }[] | null;
    error: unknown;
  };
  if (intakeError) {
    console.error("[sales-analytics] intake lookup failed");
    return NextResponse.json({ error: "Failed to load events." }, { status: 500 });
  }
  const intakes = intakeRows ?? [];

  let intake: { id: string; name: string } | null;
  if (filters.intakeId) {
    // Only the caller's own events: never pass another tenant's id through.
    intake = intakes.find((i) => i.id === filters.intakeId) ?? null;
    if (!intake) return NextResponse.json({ error: "Not Found", message: "Event not found." }, { status: 404 });
  } else {
    intake = pickDefaultIntake(intakes, await latestSaleIntakeId(supabase, tenantId));
  }

  let ticketTypes: { id: string; level: string }[] = [];
  if (intake) {
    const { data: classRows, error: classError } = (await supabase
      .from("classes")
      .select("id, level")
      .eq("tenant_id", tenantId)
      .eq("intake_id", intake.id)) as { data: { id: string; level: string }[] | null; error: unknown };
    if (classError) {
      console.error("[sales-analytics] ticket type lookup failed");
      return NextResponse.json({ error: "Failed to load ticket types." }, { status: 500 });
    }
    ticketTypes = classRows ?? [];
  }

  if (filters.classId && !ticketTypes.some((t) => t.id === filters.classId)) {
    return badRequest("class_id is not a ticket type of this event.");
  }

  return {
    supabase,
    intakes,
    intake,
    ticketTypes,
    filters: { ...filters, intakeId: intake?.id ?? null },
  };
}

/**
 * The event of the tenant's most recent confirmed, non-test order, so the page
 * opens on the event that is selling now rather than the newest one created
 * (often a test event). Single orders carry the ticket type on the enrollment;
 * cart orders on their items. Null when there is no sale or the lookup fails —
 * the default is a convenience, so it never fails the request.
 */
async function latestSaleIntakeId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  tenantId: string,
): Promise<string | null> {
  const { data, error } = (await supabase
    .from("enrollments")
    .select("classes(intake_id), enrollment_items(classes(intake_id))")
    .eq("tenant_id", tenantId)
    .eq("status", "confirmed")
    .is("internal_test_at", null)
    .order("enrolled_at", { ascending: false })
    .limit(1)
    .maybeSingle()) as {
    data: {
      classes: { intake_id: string } | null;
      enrollment_items: { classes: { intake_id: string } | null }[] | null;
    } | null;
    error: { code?: string } | null;
  };
  if (error) {
    console.error("[sales-analytics] latest sale lookup failed:", error.code ?? "");
    return null;
  }
  return data?.classes?.intake_id ?? data?.enrollment_items?.[0]?.classes?.intake_id ?? null;
}

/** RPC arguments shared by both functions. */
export function rpcArgs(filters: SalesFilters) {
  return {
    p_intake_id: filters.intakeId,
    p_from: filters.from,
    p_to: filters.to,
    p_class_id: filters.classId,
  };
}
