import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest } from "@/lib/api";
import type { JlptLevel, Intake } from "@/types/database";

const VALID_LEVELS: JlptLevel[] = ["N5", "N4", "N3", "N2", "N1"];

type IntakeResult = { data: Pick<Intake, "id" | "name"> | null; error: unknown };

export interface AnnouncementRow {
  id:           string;
  intake_id:    string | null;
  class_level:  JlptLevel | null;
  target_label: string;
  message:      string;
  sent_by_id:   string | null;
  sent_by_name: string | null;
  created_at:   string;
}

// ─── GET /api/admin/announcements ────────────────────────────────────────────
// List all announcements for the tenant, newest first.

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const { data, error } = await supabase
    .from("announcements")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false }) as {
    data: AnnouncementRow[] | null;
    error: unknown;
  };

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

// ─── POST /api/admin/announcements ───────────────────────────────────────────
// Create a new announcement (saves for history; Sprint 4 wires dispatch).
//
// Body: { intake_id, class_level?: JlptLevel | null, message }

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId, user } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { intake_id, class_level = null, message } = body as Record<string, unknown>;

  if (!intake_id || typeof intake_id !== "string") {
    return badRequest("intake_id is required.");
  }
  if (class_level !== null && !VALID_LEVELS.includes(class_level as JlptLevel)) {
    return badRequest(`class_level must be null or one of: ${VALID_LEVELS.join(", ")}.`);
  }
  if (!message || typeof message !== "string" || message.trim() === "") {
    return badRequest("message is required.");
  }

  // Verify intake belongs to this tenant and get its name
  const { data: intake } = await supabase
    .from("intakes")
    .select("id, name")
    .eq("id", intake_id)
    .eq("tenant_id", tenantId)
    .single() as IntakeResult;

  if (!intake) {
    return NextResponse.json({ error: "Not Found", message: "Intake not found." }, { status: 404 });
  }

  const target_label = class_level
    ? `${class_level} — ${intake.name}`
    : `All Classes — ${intake.name}`;

  const { data, error } = await supabase
    .from("announcements")
    .insert({
      tenant_id:    tenantId,
      intake_id:    intake_id,
      class_level:  (class_level as JlptLevel | null) ?? null,
      target_label,
      message:      message.trim(),
      sent_by_id:   user.id,
      sent_by_name: user.full_name ?? user.email,
    } as never)
    .select()
    .single() as { data: AnnouncementRow | null; error: unknown };

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
