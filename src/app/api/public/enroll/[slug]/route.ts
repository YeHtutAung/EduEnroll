import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatMMK } from "@/lib/utils";
import type { Intake, Class } from "@/types/database";

// Always fetch live data — intake/class availability changes in real time
export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PublicClassView {
  id: string;
  level: Class["level"];
  fee_mmk: number;
  fee_formatted: string;   // e.g. "၃၀၀,၀၀၀ MMK"
  seat_remaining: number;
  seat_total: number;
  enrollment_close_at: string | null;
  status: Class["status"];
}

interface PublicIntakeResponse {
  intake: Pick<Intake, "id" | "name" | "year" | "status">;
  classes: PublicClassView[];
}

// ─── Slug parser ──────────────────────────────────────────────────────────────
// Converts "april-2026" → { month: "april", year: 2026 }
// Supports multi-word months: "new-year-2026" → month: "new year"

function parseIntakeSlug(slug: string): { month: string; year: number } | null {
  const parts = slug.toLowerCase().split("-");
  if (parts.length < 2) return null;

  const rawYear = parts[parts.length - 1];
  const year = parseInt(rawYear, 10);
  if (isNaN(year) || year < 2020 || year > 2100) return null;

  const month = parts.slice(0, -1).join(" "); // "april" or "new year"
  if (!month) return null;

  return { month, year };
}

// ─── GET /api/public/enroll/[slug] ───────────────────────────────────────────
// Public — no authentication required.
//
// Returns the intake that matches the slug and all classes with
// status='open' and at least one seat remaining.
//
// Slug format: "{month}-{year}"  e.g. "april-2026", "january-2026"

export async function GET(
  _request: NextRequest,
  { params }: { params: { slug: string } },
) {
  const parsed = parseIntakeSlug(params.slug);
  if (!parsed) {
    return NextResponse.json(
      { error: "Invalid slug format. Expected: {month}-{year}  e.g. april-2026" },
      { status: 400 },
    );
  }

  // Service-role client bypasses RLS — safe here because we control
  // exactly what fields are returned to the public.
  const supabase = createAdminClient();

  // ── Find the matching intake ──────────────────────────────────
  const { data: intakes, error: intakeError } = await supabase
    .from("intakes")
    .select("id, name, year, status")
    .eq("year", parsed.year)
    .eq("status", "open")
    .ilike("name", `%${parsed.month}%`)
    .limit(1);

  if (intakeError) {
    return NextResponse.json({ error: "Failed to fetch intake." }, { status: 500 });
  }
  if (!intakes || intakes.length === 0) {
    return NextResponse.json(
      { error: "No open intake found for this slug." },
      { status: 404 },
    );
  }

  const intake = intakes[0] as Pick<Intake, "id" | "name" | "year" | "status">;

  // ── Fetch all visible classes (open + full) ──────────────────
  const { data: classes, error: classError } = await supabase
    .from("classes")
    .select("id, level, fee_mmk, seat_remaining, seat_total, enrollment_close_at, status")
    .eq("intake_id", intake.id)
    .in("status", ["open", "full"])
    .order("level");   // N1 … N5 alphabetically; re-sorted below

  if (classError) {
    return NextResponse.json({ error: "Failed to fetch classes." }, { status: 500 });
  }

  // Sort N5 → N4 → N3 → N2 → N1 (beginner first)
  const LEVEL_ORDER = ["N5", "N4", "N3", "N2", "N1"];
  const sorted = ((classes ?? []) as Class[]).sort(
    (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level),
  );

  const publicClasses: PublicClassView[] = sorted.map((c) => ({
    id:                   c.id,
    level:                c.level,
    fee_mmk:              c.fee_mmk,
    fee_formatted:        formatMMK(c.fee_mmk),
    seat_remaining:       c.seat_remaining,
    seat_total:           c.seat_total,
    enrollment_close_at:  c.enrollment_close_at,
    status:               c.status,
  }));

  const response: PublicIntakeResponse = {
    intake,
    classes: publicClasses,
  };

  return NextResponse.json(response);
}
