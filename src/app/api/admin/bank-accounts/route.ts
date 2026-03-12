import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireOwner, badRequest } from "@/lib/api";
import type { BankAccount } from "@/types/database";

type BankAccountResult  = { data: BankAccount   | null; error: unknown };
type BankAccountsResult = { data: BankAccount[] | null; error: unknown };

// ─── GET /api/admin/bank-accounts ─────────────────────────────────────────────
// List all bank accounts for the authenticated tenant (active + inactive).

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const { data, error } = await supabase
    .from("bank_accounts")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true }) as BankAccountsResult;

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

// ─── POST /api/admin/bank-accounts ────────────────────────────────────────────
// Create a new bank account for the tenant.
//
// Body: { bank_name, account_number, account_holder, qr_code_url?, is_active? }

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { bank_name, account_number, account_holder, qr_code_url, is_active = true } =
    body as Record<string, unknown>;

  if (!bank_name || typeof bank_name !== "string" || bank_name.trim() === "") {
    return badRequest("bank_name is required.");
  }
  if (bank_name.trim().length > 50) {
    return badRequest("bank_name must be 50 characters or fewer.");
  }
  // account_number is optional when a QR code is provided (e.g. KPay, Wave Money)
  if (!qr_code_url && (!account_number || typeof account_number !== "string" || account_number.trim() === "")) {
    return badRequest("account_number is required (unless a QR code is provided).");
  }
  if (!account_holder || typeof account_holder !== "string" || account_holder.trim() === "") {
    return badRequest("account_holder is required.");
  }
  if (typeof is_active !== "boolean") {
    return badRequest("is_active must be a boolean.");
  }
  if (qr_code_url !== undefined && qr_code_url !== null && typeof qr_code_url !== "string") {
    return badRequest("qr_code_url must be a string or null.");
  }

  const { data, error } = await supabase
    .from("bank_accounts")
    .insert({
      tenant_id:      tenantId,
      bank_name:      bank_name.trim(),
      account_number: typeof account_number === "string" ? account_number.trim() : "",
      account_holder: account_holder.trim(),
      qr_code_url:    (qr_code_url as string | null) ?? null,
      is_active,
    } as never)
    .select()
    .single() as BankAccountResult;

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
