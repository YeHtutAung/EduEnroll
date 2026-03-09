import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatMMKSimple } from "@/lib/utils";
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
  enrollment_open_at: string | null;
  enrollment_close_at: string | null;
  status: Class["status"];
  mode: Class["mode"];
  event_date: string | null;
  start_time: string | null;
  end_time: string | null;
  venue: string | null;
  image_url: string | null;
}

interface TenantLabelsView {
  intake: string;
  class: string;
  student: string;
  seat: string;
  fee: string;
  orgType: string;
}

interface PublicIntakeResponse {
  intake: Pick<Intake, "id" | "name" | "year" | "status">;
  classes: PublicClassView[];
  labels: TenantLabelsView;
}

// ─── Slug validation ─────────────────────────────────────────────────────────

function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length < 200;
}

// ─── GET /api/public/enroll/[slug] ───────────────────────────────────────────
// Public — no authentication required.

export async function GET(
  _request: NextRequest,
  { params }: { params: { slug: string } },
) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  if (!isValidSlug(params.slug)) {
    return NextResponse.json(
      { error: "Invalid slug." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // ── Fetch tenant labels ────────────────────────────────────────
  const { data: tenantRow } = (await supabase
    .from("tenants")
    .select("org_type, label_intake, label_class, label_student, label_seat, label_fee")
    .eq("id", tenantId)
    .single()) as {
    data: { org_type: string; label_intake: string; label_class: string; label_student: string; label_seat: string; label_fee: string } | null;
    error: unknown;
  };
  const labels: TenantLabelsView = {
    intake:  tenantRow?.label_intake  || "Intake",
    class:   tenantRow?.label_class   || "Class Type",
    student: tenantRow?.label_student || "Student",
    seat:    tenantRow?.label_seat    || "Seat",
    fee:     tenantRow?.label_fee     || "Fee",
    orgType: tenantRow?.org_type      || "language_school",
  };

  // ── Find the matching intake by slug column ────────────────────
  const { data: intakes, error: intakeError } = await supabase
    .from("intakes")
    .select("id, name, year, status")
    .eq("tenant_id", tenantId)
    .eq("slug", params.slug.toLowerCase())
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
    // Fetch earliest enrollment_open_at from classes to show "Opens on" date
    const { data: draftClasses } = await supabase
      .from("classes")
      .select("enrollment_open_at")
      .eq("intake_id", intake.id)
      .eq("tenant_id", tenantId)
      .not("enrollment_open_at", "is", null)
      .order("enrollment_open_at", { ascending: true })
      .limit(1) as { data: { enrollment_open_at: string }[] | null; error: unknown };

    const opensAt = draftClasses?.[0]?.enrollment_open_at ?? null;

    return NextResponse.json(
      { error: "This intake is not yet open for enrollment.", code: "INTAKE_DRAFT", intake, opens_at: opensAt },
      { status: 410 },
    );
  }

  // ── Fetch all visible classes (open + full) ──────────────────
  const { data: classes, error: classError } = await supabase
    .from("classes")
    .select("id, level, fee_mmk, seat_remaining, seat_total, enrollment_open_at, enrollment_close_at, status, mode, event_date, start_time, end_time, venue, image_url")
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
    fee_formatted:        formatMMKSimple(c.fee_mmk),
    seat_remaining:       c.seat_remaining,
    seat_total:           c.seat_total,
    enrollment_open_at:   c.enrollment_open_at,
    enrollment_close_at:  c.enrollment_close_at,
    status:               c.status,
    mode:                 c.mode ?? "offline",
    event_date:           c.event_date ?? null,
    start_time:           c.start_time ?? null,
    end_time:             c.end_time ?? null,
    venue:                c.venue ?? null,
    image_url:            c.image_url ?? null,
  }));

  const response: PublicIntakeResponse = {
    intake,
    classes: publicClasses,
    labels,
  };

  return NextResponse.json(response);
}
