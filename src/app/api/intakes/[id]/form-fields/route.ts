import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";

// ─── Types ───────────────────────────────────────────────────────────────────

const VALID_FIELD_TYPES = [
  "text", "select", "radio", "file", "date", "checkbox", "phone", "address",
] as const;

type FieldType = (typeof VALID_FIELD_TYPES)[number];

interface FormField {
  id: string;
  intake_id: string;
  field_key: string;
  field_label: string;
  field_type: FieldType;
  is_required: boolean;
  options: unknown;
  sort_order: number;
  is_default: boolean;
  created_at: string;
}

type FieldResult = { data: FormField | null; error: unknown };
type FieldsResult = { data: FormField[] | null; error: unknown };

// ─── Verify intake belongs to tenant ─────────────────────────────────────────

async function verifyIntakeOwnership(
  supabase: ReturnType<typeof Object>,
  intakeId: string,
  tenantId: string,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("intakes")
    .select("id")
    .eq("id", intakeId)
    .eq("tenant_id", tenantId)
    .maybeSingle() as { data: { id: string } | null; error: unknown };
  return !!data;
}

// ─── GET /api/intakes/[id]/form-fields ───────────────────────────────────────
// Returns all form fields for the intake, ordered by sort_order.

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  if (!(await verifyIntakeOwnership(supabase, params.id, tenantId))) {
    return notFound("Intake");
  }

  const { data, error } = await supabase
    .from("intake_form_fields")
    .select("*")
    .eq("intake_id", params.id)
    .order("sort_order", { ascending: true }) as FieldsResult;

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

// ─── POST /api/intakes/[id]/form-fields ──────────────────────────────────────
// Add a new custom field.
// Body: { field_key, field_label, field_type, is_required?, options?, sort_order? }

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  if (!(await verifyIntakeOwnership(supabase, params.id, tenantId))) {
    return notFound("Intake");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { field_key, field_label, field_type, is_required, options, sort_order } =
    body as Record<string, unknown>;

  if (!field_key || typeof field_key !== "string" || field_key.trim() === "") {
    return badRequest("field_key is required.");
  }
  if (!field_label || typeof field_label !== "string" || field_label.trim() === "") {
    return badRequest("field_label is required.");
  }
  if (!VALID_FIELD_TYPES.includes(field_type as FieldType)) {
    return badRequest(`field_type must be one of: ${VALID_FIELD_TYPES.join(", ")}.`);
  }

  const { data, error } = await supabase
    .from("intake_form_fields")
    .insert({
      intake_id: params.id,
      field_key: (field_key as string).trim(),
      field_label: (field_label as string).trim(),
      field_type: field_type as string,
      is_required: typeof is_required === "boolean" ? is_required : true,
      options: options ?? null,
      sort_order: typeof sort_order === "number" ? sort_order : 99,
      is_default: false,
    } as never)
    .select()
    .single() as FieldResult;

  if (error) {
    const msg = (error as { message: string }).message;
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return badRequest("A field with this key already exists for this intake.");
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

// ─── PATCH /api/intakes/[id]/form-fields ─────────────────────────────────────
// Update an existing field.
// Body: { id, field_label?, field_type?, is_required?, options?, sort_order? }

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  if (!(await verifyIntakeOwnership(supabase, params.id, tenantId))) {
    return notFound("Intake");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { id: fieldId, field_label, field_type, is_required, options, sort_order } =
    body as Record<string, unknown>;

  if (!fieldId || typeof fieldId !== "string") {
    return badRequest("id (field ID) is required.");
  }

  const update: Record<string, unknown> = {};

  if (field_label !== undefined) {
    if (typeof field_label !== "string" || field_label.trim() === "") {
      return badRequest("field_label must be a non-empty string.");
    }
    update.field_label = field_label.trim();
  }
  if (field_type !== undefined) {
    if (!VALID_FIELD_TYPES.includes(field_type as FieldType)) {
      return badRequest(`field_type must be one of: ${VALID_FIELD_TYPES.join(", ")}.`);
    }
    update.field_type = field_type;
  }
  if (is_required !== undefined) update.is_required = !!is_required;
  if (options !== undefined) update.options = options;
  if (sort_order !== undefined) update.sort_order = sort_order;

  if (Object.keys(update).length === 0) {
    return badRequest("No valid fields provided for update.");
  }

  const { data, error } = await supabase
    .from("intake_form_fields")
    .update(update as never)
    .eq("id", fieldId)
    .eq("intake_id", params.id)
    .select()
    .single() as FieldResult;

  if (error || !data) return notFound("Form field");

  return NextResponse.json(data);
}

// ─── DELETE /api/intakes/[id]/form-fields ────────────────────────────────────
// Delete a custom field. Blocked if is_default=true.
// Body: { id }

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  if (!(await verifyIntakeOwnership(supabase, params.id, tenantId))) {
    return notFound("Intake");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { id: fieldId } = body as Record<string, unknown>;

  if (!fieldId || typeof fieldId !== "string") {
    return badRequest("id (field ID) is required.");
  }

  // Check if field is a default field
  const { data: field } = await supabase
    .from("intake_form_fields")
    .select("id, is_default")
    .eq("id", fieldId)
    .eq("intake_id", params.id)
    .single() as { data: { id: string; is_default: boolean } | null; error: unknown };

  if (!field) return notFound("Form field");

  if (field.is_default) {
    return badRequest("Default fields cannot be deleted.");
  }

  const { error } = await supabase
    .from("intake_form_fields")
    .delete()
    .eq("id", fieldId)
    .eq("intake_id", params.id);

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
