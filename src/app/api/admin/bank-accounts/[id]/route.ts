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

  const { is_active, account_number, account_holder, bank_name, qr_code_url } =
    body as Record<string, unknown>;

  if (
    is_active === undefined &&
    account_number === undefined &&
    account_holder === undefined &&
    bank_name === undefined &&
    qr_code_url === undefined
  ) {
    return badRequest("Provide at least one field to update.");
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
  if (bank_name !== undefined && (typeof bank_name !== "string" || bank_name.trim() === "")) {
    return badRequest("bank_name must be a non-empty string.");
  }
  if (qr_code_url !== undefined && qr_code_url !== null && typeof qr_code_url !== "string") {
    return badRequest("qr_code_url must be a string or null.");
  }

  const patch: Record<string, unknown> = {};
  if (is_active !== undefined)      patch.is_active      = is_active;
  if (account_number !== undefined) patch.account_number = (account_number as string).trim();
  if (account_holder !== undefined) patch.account_holder = (account_holder as string).trim();
  if (bank_name !== undefined)      patch.bank_name      = (bank_name as string).trim();
  if (qr_code_url !== undefined)    patch.qr_code_url    = qr_code_url;

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

  // Verify existence and get qr_code_url for cleanup
  const { data: existing } = await supabase
    .from("bank_accounts")
    .select("id, qr_code_url")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as { data: { id: string; qr_code_url: string | null } | null; error: unknown };

  if (!existing) return notFound("Bank account");

  const admin = createAdminClient();

  // Clean up QR code image from storage if it exists
  if (existing.qr_code_url) {
    const url = new URL(existing.qr_code_url);
    const path = url.pathname.replace("/storage/v1/object/public/qr-codes/", "");
    if (path) {
      await admin.storage.from("qr-codes").remove([path]);
    }
  }

  const { error } = await admin
    .from("bank_accounts")
    .delete()
    .eq("id", params.id)
    .eq("tenant_id", tenantId);

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
