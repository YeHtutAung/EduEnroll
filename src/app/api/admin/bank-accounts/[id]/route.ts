import { NextRequest, NextResponse } from "next/server";
import { requireOwner, badRequest, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BankAccount } from "@/types/database";

type BankAccountResult = { data: BankAccount | null; error: unknown };

// ─── PATCH /api/admin/bank-accounts/[id] ──────────────────────────────────────
// Update a bank account. Supported fields: is_active (toggle), account_number,
// account_holder.

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { is_active, account_number, account_holder } = body as Record<string, unknown>;

  if (
    is_active === undefined &&
    account_number === undefined &&
    account_holder === undefined
  ) {
    return badRequest("Provide at least one field to update: is_active, account_number, account_holder.");
  }
  if (is_active !== undefined && typeof is_active !== "boolean") {
    return badRequest("is_active must be a boolean.");
  }
  if (account_number !== undefined && (typeof account_number !== "string" || account_number.trim() === "")) {
    return badRequest("account_number must be a non-empty string.");
  }
  if (account_holder !== undefined && (typeof account_holder !== "string" || account_holder.trim() === "")) {
    return badRequest("account_holder must be a non-empty string.");
  }

  const patch: Record<string, unknown> = {};
  if (is_active !== undefined)      patch.is_active      = is_active;
  if (account_number !== undefined) patch.account_number = (account_number as string).trim();
  if (account_holder !== undefined) patch.account_holder = (account_holder as string).trim();

  const { data, error } = await supabase
    .from("bank_accounts")
    .update(patch as never)
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .select()
    .single() as BankAccountResult;

  if (error || !data) return notFound("Bank account");

  return NextResponse.json(data);
}

// ─── DELETE /api/admin/bank-accounts/[id] ─────────────────────────────────────
// Permanently remove a bank account.

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  // Verify existence (session client, RLS scoped to tenant) → 404 if not found
  const { data: existing } = await supabase
    .from("bank_accounts")
    .select("id")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as BankAccountResult;

  if (!existing) return notFound("Bank account");

  // Use service-role client for the DELETE: migration 007 has no DELETE RLS
  // policy (only SELECT/INSERT/UPDATE), so the session client silently ignores
  // the delete. Admin client bypasses RLS and guarantees the row is removed.
  const admin = createAdminClient();
  const { error } = await admin
    .from("bank_accounts")
    .delete()
    .eq("id", params.id)
    .eq("tenant_id", tenantId); // keep tenant scope even with service role

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
