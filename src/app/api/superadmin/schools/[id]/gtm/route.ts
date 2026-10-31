import { NextRequest, NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeGtmContainerId } from "@/lib/tagManager";

// ─── PUT /api/superadmin/schools/[id]/gtm ───────────────────────────────────
// Set or clear a tenant's Google Tag Manager container. The DB trigger only
// lets the service role change tenants.gtm_container_id, so this writes
// through the admin client after the superadmin check.

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireSuperadmin();
  if ("error" in auth && auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("gtm_container_id" in body)
  ) {
    return NextResponse.json(
      { error: "Body must be { gtm_container_id: string | null }" },
      { status: 400 },
    );
  }

  const raw = (body as { gtm_container_id: unknown }).gtm_container_id;
  if (raw !== null && typeof raw !== "string") {
    return NextResponse.json({ error: "gtm_container_id must be a string or null" }, { status: 400 });
  }

  const next = normalizeGtmContainerId(raw);
  if (next === "invalid") {
    return NextResponse.json(
      { error: "gtm_container_id must look like GTM-XXXXXXX" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: existing, error: readError } = (await admin
    .from("tenants")
    .select("id, gtm_container_id")
    .eq("id", params.id)
    .maybeSingle()) as unknown as {
    data: { id: string; gtm_container_id: string | null } | null;
    error: unknown;
  };

  if (readError) {
    return NextResponse.json({ error: "Failed to read tenant" }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "School not found" }, { status: 404 });
  }

  const { error: updateError } = await admin
    .from("tenants")
    .update({ gtm_container_id: next } as never)
    .eq("id", params.id);

  if (updateError) {
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }

  console.log(
    `[gtm] tenant=${params.id} changed by superadmin=${auth.profile!.id}: ${existing.gtm_container_id ?? "null"} -> ${next ?? "null"}`,
  );

  return NextResponse.json({ gtm_container_id: next });
}
