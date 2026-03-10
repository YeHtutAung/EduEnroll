import { NextRequest, NextResponse } from "next/server";
import { requireOwner, badRequest } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── DELETE /api/admin/staff/[id] ─────────────────────────────────────────────
// Remove a staff member from the tenant. Owner-only.
// Prevents owner from removing themselves or another owner.

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId, user } = auth;

  const staffId = params.id;

  // Cannot remove yourself
  if (staffId === user.id) {
    return badRequest("You cannot remove yourself.");
  }

  // Verify the target exists and belongs to the same tenant
  const admin = createAdminClient();
  const { data: target } = await admin
    .from("users")
    .select("id, role, tenant_id")
    .eq("id", staffId)
    .maybeSingle() as { data: { id: string; role: string; tenant_id: string } | null; error: unknown };

  if (!target || target.tenant_id !== tenantId) {
    return NextResponse.json(
      { error: "Not Found", message: "Staff member not found." },
      { status: 404 },
    );
  }

  // Cannot remove another owner
  if (target.role === "owner") {
    return badRequest("Cannot remove an owner.");
  }

  // Delete from users table (auth.users entry remains but they lose tenant access)
  const { error } = await admin
    .from("users")
    .delete()
    .eq("id", staffId)
    .eq("tenant_id", tenantId);

  if (error) {
    console.error("[staff] Delete error:", (error as Error).message);
    return NextResponse.json(
      { error: "Failed to remove staff member." },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
