import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import type { BankAccount } from "@/types/database";

export const dynamic = "force-dynamic";

type PublicBankAccount = Pick<BankAccount, "bank_name" | "account_number" | "account_holder">;

// ─── GET /api/public/bank-accounts ──────────────────────────────────────────
// Public — no authentication required.
// Returns only active bank accounts with minimal fields, scoped to tenant.

export async function GET() {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("bank_accounts")
    .select("bank_name, account_number, account_holder")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("bank_name") as { data: PublicBankAccount[] | null; error: unknown };

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch bank accounts." },
      { status: 500 },
    );
  }

  return NextResponse.json(data ?? []);
}
