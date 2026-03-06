import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
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
  mode: Class["mode"];
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

export async function GET(
  _request: NextRequest,
  { params }: { params: { slug: string } },
) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const parsed = parseIntakeSlug(params.slug);
  if (!parsed) {
    return NextResponse.json(
      { error: "Invalid slug format. Expected: {month}-{year}  e.g. april-2026" },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // ── Find the matching intake (any status) ────────────────────
  const { data: intakes, error: intakeError } = await supabase
    .from("intakes")
    .select("id, name, year, status")
    .eq("tenant_id", tenantId)
    .eq("year", parsed.year)
    .ilike("name", `%${parsed.month}%`)
    .limit(1);

  if (intakeError) {
    return NextResponse.json({ error: "Failed to fetch intake." }, { status: 500 });
  }
  if (!intakes || intakes.length === 0) {
    return NextResponse.json(
      { error: "No intake found for this slug.", code: "NOT_FOUND" },
      { status: 404 },
    );
  }

  const intake = intakes[0] as Pick<Intake, "id" | "name" | "year" | "status">;

  if (intake.status === "closed") {
    return NextResponse.json(
      { error: "Enrollment for this intake is closed.", code: "INTAKE_CLOSED", intake },
      { status: 410 },
    );
  }
  if (intake.status === "draft") {
    return NextResponse.json(
      { error: "This intake is not yet open for enrollment.", code: "INTAKE_DRAFT", intake },
      { status: 410 },
    );
  }

  // ── Fetch all visible classes (open + full) ──────────────────
  const { data: classes, error: classError } = await supabase
    .from("classes")
    .select("id, level, fee_mmk, seat_remaining, seat_total, enrollment_close_at, status, mode")
    .eq("intake_id", intake.id)
    .eq("tenant_id", tenantId)
    .in("status", ["open", "full"])
    .order("level");

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
    mode:                 c.mode ?? "offline",
  }));

  const response: PublicIntakeResponse = {
    intake,
    classes: publicClasses,
  };

  return NextResponse.json(response);
}
