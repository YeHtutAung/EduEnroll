import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest } from "@/lib/api";
import type { Intake, IntakeStatus } from "@/types/database";

const VALID_STATUSES: IntakeStatus[] = ["draft", "open", "closed"];

// Nihon Moment runs 4 intakes per year
export const INTAKE_NAMES = ["January", "April", "July", "October"] as const;

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

  const { data, error } = await supabase
    .from("intakes")
    .insert({
      tenant_id: tenantId,
      name: name.trim(),
      year: year as number,
      status: status as IntakeStatus,
    } as never)
    .select()
    .single() as IntakeResult;

  if (error) {
    return NextResponse.json({ error: (error as { message: string }).message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
