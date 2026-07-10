import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveScannerTenant } from "@/lib/scanner/apiKey";

// ─── GET /api/events ────────────────────────────────────────────────────────
// Called by the kuunyi-scanner app at startup to populate its event picker.
// Auth is a per-tenant Bearer API key (scanner_api_keys) — the tenant comes
// from the key, not the host.
//
// Returns: [{ id, name, date, location }] for the tenant's OPEN intakes that
// have at least one class with a future (or today) event_date. `id` matches
// the `eid` claim embedded in ticket JWTs.

interface IntakeRow {
  id: string;
  name: string;
  status: string;
}

interface ClassRow {
  intake_id: string;
  event_date: string | null;
  venue: string | null;
}

export async function GET(request: NextRequest) {
  const tenantId = await resolveScannerTenant(request);
  if (!tenantId) {
    return NextResponse.json(
      { error: "Unauthorized", message: "Invalid or missing API key." },
      { status: 401 },
    );
  }

  const supabase = createAdminClient();

  const { data: intakes } = (await supabase
    .from("intakes")
    .select("id, name, status")
    .eq("tenant_id", tenantId)
    .eq("status", "open")) as unknown as { data: IntakeRow[] | null; error: unknown };

  if (!intakes || intakes.length === 0) {
    return NextResponse.json([]);
  }

  const intakeIds = intakes.map((intake) => intake.id);

  const { data: classes } = (await supabase
    .from("classes")
    .select("intake_id, event_date, venue")
    .eq("tenant_id", tenantId)
    .in("intake_id", intakeIds)) as unknown as { data: ClassRow[] | null; error: unknown };

  // Group classes by intake_id and pick the earliest non-null event_date per intake.
  const earliestByIntake = new Map<string, { event_date: string; venue: string | null }>();
  for (const row of classes ?? []) {
    if (!row.event_date) continue;
    const existing = earliestByIntake.get(row.intake_id);
    if (!existing || row.event_date < existing.event_date) {
      earliestByIntake.set(row.intake_id, { event_date: row.event_date, venue: row.venue });
    }
  }

  // Date-only comparison (YYYY-MM-DD string compare) avoids timezone-parsing
  // pitfalls that `new Date(...)` object comparisons are prone to.
  const todayStr = new Date().toISOString().slice(0, 10);

  const events = intakes
    .map((intake) => {
      const earliest = earliestByIntake.get(intake.id);
      if (!earliest) return null;
      if (earliest.event_date < todayStr) return null;

      return {
        id: intake.id,
        name: intake.name,
        date: new Date(earliest.event_date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        location: earliest.venue,
      };
    })
    .filter((event): event is NonNullable<typeof event> => event !== null);

  return NextResponse.json(events);
}
