import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";

// ─── POST /api/intakes/[id]/form-fields/apply ────────────────────────────────
// Copy non-default custom fields from source intake to target intakes.
// Body: { targetIntakeIds: string[] }

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  // Verify source intake belongs to tenant
  const { data: source } = await supabase
    .from("intakes")
    .select("id")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as { data: { id: string } | null; error: unknown };

  if (!source) return notFound("Source intake");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { targetIntakeIds } = body as { targetIntakeIds?: string[] };

  if (!Array.isArray(targetIntakeIds) || targetIntakeIds.length === 0) {
    return badRequest("targetIntakeIds must be a non-empty array.");
  }

  // Verify all targets belong to this tenant and are draft
  const { data: targets } = await supabase
    .from("intakes")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .in("id", targetIntakeIds) as {
    data: { id: string; status: string }[] | null;
    error: unknown;
  };

  if (!targets || targets.length === 0) {
    return badRequest("No valid target intakes found.");
  }

  const draftTargets = targets.filter((t) => t.status === "draft");
  if (draftTargets.length === 0) {
    return badRequest("All selected intakes must be in Draft status.");
  }

  // Fetch non-default fields from source
  const { data: sourceFields } = await supabase
    .from("intake_form_fields")
    .select("field_key, field_label, field_type, is_required, options, sort_order")
    .eq("intake_id", params.id)
    .eq("is_default", false)
    .order("sort_order", { ascending: true }) as {
    data: {
      field_key: string;
      field_label: string;
      field_type: string;
      is_required: boolean;
      options: unknown;
      sort_order: number;
    }[] | null;
    error: unknown;
  };

  let appliedCount = 0;

  for (const target of draftTargets) {
    // Delete existing non-default fields from target
    await supabase
      .from("intake_form_fields")
      .delete()
      .eq("intake_id", target.id)
      .eq("is_default", false);

    // Insert source fields into target (if any)
    if (sourceFields && sourceFields.length > 0) {
      await supabase
        .from("intake_form_fields")
        .insert(
          sourceFields.map((f) => ({
            intake_id: target.id,
            field_key: f.field_key,
            field_label: f.field_label,
            field_type: f.field_type,
            is_required: f.is_required,
            options: f.options,
            sort_order: f.sort_order,
            is_default: false,
          })) as never[],
        );
    }

    appliedCount++;
  }

  return NextResponse.json({ applied: appliedCount });
}
