import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest } from "@/lib/api";
import type { Intake, IntakeStatus } from "@/types/database";

const VALID_STATUSES: IntakeStatus[] = ["draft", "open", "closed"];

type IntakeResult  = { data: Intake   | null; error: unknown };
type IntakesResult = { data: Intake[] | null; error: unknown };

// ─── GET /api/intakes ─────────────────────────────────────────────────────────
// List all intakes for the authenticated user's tenant, newest year first.

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const { data, error } = await supabase
    .from("intakes")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("year", { ascending: false })
    .order("name", { ascending: true }) as IntakesResult;

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

// ─── POST /api/intakes ────────────────────────────────────────────────────────
// Create a new intake.
//
// Body: { name: string, year: number, status?: IntakeStatus }
//
// name examples:
//   "January 2026 Intake"   /   "ဇန်နဝါရီ ၂၀၂၆ စာရင်းသွင်းမှု"
// Nihon Moment runs 4 intakes per year: January, April, July, October.

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { name, year, status = "draft" } = body as Record<string, unknown>;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return badRequest("name is required.");
  }
  if (!year || typeof year !== "number" || !Number.isInteger(year) || year < 2020 || year > 2100) {
    return badRequest("year must be an integer between 2020 and 2100.");
  }
  if (!VALID_STATUSES.includes(status as IntakeStatus)) {
    return badRequest(`status must be one of: ${VALID_STATUSES.join(", ")}.`);
  }

  // Check for duplicate intake (same name + year for this tenant)
  const { data: existing } = await supabase
    .from("intakes")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("name", (name as string).trim())
    .eq("year", year as number)
    .maybeSingle() as { data: { id: string } | null; error: unknown };

  if (existing) {
    return NextResponse.json(
      { error: "An intake with this name and year already exists." },
      { status: 400 },
    );
  }

  // Generate a stable slug from the name (first word + year)
  const slug = (name as string).trim().split(/\s+/)[0].toLowerCase() + "-" + year;

  const { data, error } = await supabase
    .from("intakes")
    .insert({
      tenant_id: tenantId,
      name: (name as string).trim(),
      year: year as number,
      slug,
      status: status as IntakeStatus,
    } as never)
    .select()
    .single() as IntakeResult;

  if (error || !data) {
    return NextResponse.json({ error: (error as { message: string }).message }, { status: 500 });
  }

  // Seed 5 default form fields for the new intake
  const defaultFields = [
    { field_key: "name_en",  field_label: "Name (English)",  field_type: "text",  is_required: true,  sort_order: 1 },
    { field_key: "name_mm",  field_label: "Name (Myanmar)",  field_type: "text",  is_required: true,  sort_order: 2 },
    { field_key: "nrc",      field_label: "NRC Number",      field_type: "text",  is_required: true,  sort_order: 3 },
    { field_key: "phone",    field_label: "Phone Number",    field_type: "phone", is_required: true,  sort_order: 4 },
    { field_key: "email",    field_label: "Email Address",   field_type: "text",  is_required: false, sort_order: 5 },
  ];

  await supabase
    .from("intake_form_fields")
    .insert(
      defaultFields.map((f) => ({
        intake_id: (data as Intake).id,
        ...f,
        is_default: true,
      })) as never[],
    );

  return NextResponse.json(data, { status: 201 });
}
