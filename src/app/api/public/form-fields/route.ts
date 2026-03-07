import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";

// ─── GET /api/public/form-fields?intake_id=UUID ──────────────────────────────
// Public — returns form fields for an intake, ordered by sort_order.

export async function GET(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const intakeId = request.nextUrl.searchParams.get("intake_id");
  if (!intakeId) {
    return NextResponse.json({ error: "intake_id is required." }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Verify intake belongs to tenant
  const { data: intake } = await supabase
    .from("intakes")
    .select("id")
    .eq("id", intakeId)
    .eq("tenant_id", tenantId)
    .single() as { data: { id: string } | null; error: unknown };

  if (!intake) {
    return NextResponse.json({ error: "Intake not found." }, { status: 404 });
  }

  const { data: fields } = await supabase
    .from("intake_form_fields")
    .select("id, field_key, field_label, field_type, is_required, options, sort_order, is_default")
    .eq("intake_id", intakeId)
    .order("sort_order", { ascending: true }) as {
    data: {
      id: string;
      field_key: string;
      field_label: string;
      field_type: string;
      is_required: boolean;
      options: string[] | null;
      sort_order: number;
      is_default: boolean;
    }[] | null;
    error: unknown;
  };

  return NextResponse.json(fields ?? []);
}
