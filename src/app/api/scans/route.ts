import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveScannerTenant } from "@/lib/scanner/apiKey";

// ─── POST /api/scans ────────────────────────────────────────────────────────
// Called by the kuunyi-scanner app after it verifies a ticket JWT offline.
// Enforces single-use entry via a race-safe conditional update: only the
// scan that wins the `.is("first_scan_at", null)` UPDATE gets a 200; any
// concurrent/subsequent scan of the same ticket gets a 409 with the details
// of the original (winning) scan.
//
// Body: { jti: string, eid: string, gate: string }

interface TicketRow {
  id: string;
  intake_id: string;
  status: string;
  exp: string;
  first_scan_at: string | null;
  first_scan_gate: string | null;
}

interface ScanBody {
  jti?: string;
  eid?: string;
  gate?: string;
}

export async function POST(request: NextRequest) {
  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body: ScanBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  // ── 2. Auth ─────────────────────────────────────────────────────────────────
  const tenantId = await resolveScannerTenant(request);
  if (!tenantId) {
    return NextResponse.json(
      { error: "Unauthorized", message: "Invalid or missing API key." },
      { status: 401 },
    );
  }

  // ── 3. Validate body ────────────────────────────────────────────────────────
  const { jti, eid, gate } = body;
  if (!jti || typeof jti !== "string" || !eid || typeof eid !== "string") {
    return NextResponse.json(
      { error: "Bad Request", message: "jti and eid are required." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // ── 4. Load and validate ticket ─────────────────────────────────────────────
  const { data: ticket } = (await supabase
    .from("tickets")
    .select("id, intake_id, status, exp, first_scan_at, first_scan_gate")
    .eq("id", jti)
    .eq("tenant_id", tenantId)
    .single()) as unknown as { data: TicketRow | null; error: unknown };

  if (
    !ticket ||
    ticket.intake_id !== eid ||
    ticket.status !== "valid" ||
    Date.parse(ticket.exp) < Date.now()
  ) {
    return NextResponse.json({ error: "Not Found", message: "Ticket not found." }, { status: 404 });
  }

  // ── 5. Race-safe single-use claim ───────────────────────────────────────────
  const { data: claimed } = (await supabase
    .from("tickets")
    .update({ first_scan_at: new Date().toISOString(), first_scan_gate: gate } as never)
    .eq("id", jti)
    .is("first_scan_at", null)
    .select("first_scan_at, first_scan_gate")) as unknown as {
    data: { first_scan_at: string; first_scan_gate: string | null }[] | null;
  };

  if (claimed && claimed.length > 0) {
    return NextResponse.json({ ok: true });
  }

  // Someone else already claimed the first scan — re-read and report it.
  const { data: existing } = (await supabase
    .from("tickets")
    .select("first_scan_at, first_scan_gate")
    .eq("id", jti)
    .single()) as unknown as {
    data: { first_scan_at: string | null; first_scan_gate: string | null } | null;
  };

  return NextResponse.json(
    {
      firstScanTime: existing?.first_scan_at ?? null,
      firstScanGate: existing?.first_scan_gate ?? null,
    },
    { status: 409 },
  );
}
