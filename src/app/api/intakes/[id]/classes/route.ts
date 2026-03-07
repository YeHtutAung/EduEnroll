import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";
import { DEFAULT_CLASS_FEES } from "@/types/database";
import type { Class, ClassMode, Intake, JlptLevel, ClassStatus } from "@/types/database";

const JLPT_LEVELS: string[] = ["N5", "N4", "N3", "N2", "N1"];
const VALID_CLASS_STATUSES: ClassStatus[] = ["draft", "open", "full", "closed"];
const VALID_CLASS_MODES: ClassMode[] = ["online", "offline"];
const DEFAULT_SEAT_TOTAL = 30;

type IntakeResult  = { data: Intake   | null; error: unknown };
type ClassResult   = { data: Class    | null; error: unknown };
type ClassesResult = { data: Class[]  | null; error: unknown };

// ─── GET /api/intakes/[id]/classes ───────────────────────────────────────────
// List all classes for an intake, ordered N5 → N1 (beginner first).

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  // Confirm the intake exists and belongs to the caller's tenant
  const { data: intake, error: intakeError } = await supabase
    .from("intakes")
    .select("id")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as IntakeResult;

  if (intakeError || !intake) return notFound("Intake");

  const { data, error } = await supabase
    .from("classes")
    .select("*")
    .eq("intake_id", params.id)
    .eq("tenant_id", tenantId) as ClassesResult;

  if (error) {
    return NextResponse.json({ error: (error as { message: string }).message }, { status: 500 });
  }

  // Sort: JLPT levels first (N5→N1), then custom levels alphabetically
  const sorted = (data ?? []).sort((a, b) => {
    const ai = JLPT_LEVELS.indexOf(a.level);
    const bi = JLPT_LEVELS.indexOf(b.level);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.level.localeCompare(b.level);
  });

  return NextResponse.json(sorted);
}

// ─── POST /api/intakes/[id]/classes ──────────────────────────────────────────
// Create a new class for an intake.
//
// Body: {
//   level:                 JlptLevel    (required)
//   fee_mmk?:              number       (auto from level: N5=300k … N1=500k MMK)
//   seat_total?:           number       (default 30; seat_remaining set equal)
//   enrollment_open_at?:   string       ISO 8601
//   enrollment_close_at?:  string       ISO 8601
//   status?:               ClassStatus  (default 'draft')
// }

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  // Confirm the intake exists and belongs to the caller's tenant
  const { data: intake, error: intakeError } = await supabase
    .from("intakes")
    .select("id, tenant_id")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as IntakeResult;

  if (intakeError || !intake) return notFound("Intake");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const {
    level,
    fee_mmk,
    seat_total = DEFAULT_SEAT_TOTAL,
    enrollment_open_at,
    enrollment_close_at,
    status = "draft",
    mode = "offline",
    event_date,
    start_time,
    end_time,
    venue,
  } = body as Record<string, unknown>;

  // Validate level
  if (!level || typeof level !== "string" || (level as string).trim() === "") {
    return badRequest("level is required and must be a non-empty string.");
  }

  // Auto-populate fee from level if not provided (only for standard JLPT levels)
  const resolvedFee =
    fee_mmk !== undefined
      ? fee_mmk
      : DEFAULT_CLASS_FEES[level as JlptLevel] ?? undefined;

  if (resolvedFee === undefined || typeof resolvedFee !== "number" || resolvedFee <= 0) {
    return badRequest("fee_mmk must be a positive number.");
  }
  if (typeof seat_total !== "number" || !Number.isInteger(seat_total) || seat_total < 1) {
    return badRequest("seat_total must be a positive integer.");
  }
  if (enrollment_open_at !== undefined && enrollment_open_at !== null && typeof enrollment_open_at !== "string") {
    return badRequest("enrollment_open_at must be an ISO 8601 string.");
  }
  if (enrollment_close_at !== undefined && enrollment_close_at !== null && typeof enrollment_close_at !== "string") {
    return badRequest("enrollment_close_at must be an ISO 8601 string.");
  }
  if (!VALID_CLASS_STATUSES.includes(status as ClassStatus)) {
    return badRequest(`status must be one of: ${VALID_CLASS_STATUSES.join(", ")}.`);
  }
  if (!VALID_CLASS_MODES.includes(mode as ClassMode)) {
    return badRequest(`mode must be one of: ${VALID_CLASS_MODES.join(", ")}.`);
  }

  const { data, error } = await supabase
    .from("classes")
    .insert({
      intake_id: params.id,
      tenant_id: tenantId,
      level: (level as string).trim(),
      fee_mmk: resolvedFee,
      seat_total: seat_total as number,
      seat_remaining: seat_total as number,   // always starts fully available
      enrollment_open_at: (enrollment_open_at as string | null) ?? null,
      enrollment_close_at: (enrollment_close_at as string | null) ?? null,
      status: status as ClassStatus,
      mode: mode as ClassMode,
      event_date: (event_date as string | null) ?? null,
      start_time: (start_time as string | null) ?? null,
      end_time: (end_time as string | null) ?? null,
      venue: (venue as string | null) ?? null,
    } as never)
    .select()
    .single() as ClassResult;

  if (error) {
    const err = error as { code?: string; message: string };
    // Unique constraint: one class per level per intake
    if (err.code === "23505") {
      return NextResponse.json(
        { error: "Conflict", message: `A ${level} class already exists for this intake.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
