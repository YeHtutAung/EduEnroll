import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";
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
// Allowed fields: name, year, status

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (params.id === "new") return notFound("Intake");

  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { name, year, status, hero_image_url } = body as Record<string, unknown>;

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

  if (error || !data) return notFound("Intake");

  return NextResponse.json(data);
}
