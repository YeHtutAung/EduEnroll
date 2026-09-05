import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { tenantLinkOrigin } from "@/lib/origin";
import { createEnrollment } from "@/server/enrollment/createEnrollment";
import { createCartEnrollment } from "@/server/enrollment/createCartEnrollment";
import { hashPriorityToken } from "@/lib/interest/token";
import { sendEnrollmentConfirmationEmail } from "@/server/enrollment/enrollmentEmails";
import type { BankAccount } from "@/types/database";

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const { class_id, form_data, idempotency_key, quantity, items, messenger_psid, __hp, priority_token } =
    body as Record<string, unknown>;

  // Hash immediately — the raw token must never be logged, stored, or echoed
  // back, and must never be passed further down than this line.
  const priorityTokenHash =
    typeof priority_token === "string" && priority_token.length > 0
      ? hashPriorityToken(priority_token)
      : null;

  // Honeypot — fake success to fool bots
  if (__hp && typeof __hp === "string" && __hp.trim().length > 0) {
    return NextResponse.json({ enrollment_ref: "OK-0000-0000" }, { status: 200 });
  }

  const fd = form_data && typeof form_data === "object"
    ? (form_data as Record<string, string>)
    : null;

  const supabase = createAdminClient();

  // Cart checkout
  if (Array.isArray(items)) {
    const outcome = await createCartEnrollment({
      items: items as { class_id: string; quantity: number }[],
      form_data: fd,
      messenger_psid: typeof messenger_psid === "string" ? messenger_psid : null,
      priority_token_hash: priorityTokenHash,
    });

    if (!outcome.ok) {
      const errBody: Record<string, unknown> = { error: outcome.error };
      if (outcome.error === "Validation Error") {
        errBody.messages = [outcome.message];
      } else {
        errBody.message = outcome.message;
        const outcomeWithMm = outcome as typeof outcome & { message_mm?: string };
        if (outcomeWithMm.message_mm) errBody.message_mm = outcomeWithMm.message_mm;
        if (outcome.extra) Object.assign(errBody, outcome.extra);
      }
      return NextResponse.json(errBody, { status: outcome.status });
    }

    const { result } = outcome;
    const tenantInfo = await fetchTenantInfo(supabase, result.tenant_id);
    const currency = tenantInfo?.currency ?? "MMK";

    sendEnrollmentConfirmationEmail({
      fd,
      enrollmentRef: result.enrollment_ref,
      classLevel: result.items
        .map((i: { class_level: string; quantity: number }) =>
          i.quantity > 1 ? `${i.class_level} x${i.quantity}` : i.class_level,
        )
        .join(", "),
      feeAmount: result.total_fee,
      baseUrl: tenantLinkOrigin(tenantInfo?.subdomain),
      tenant: tenantInfo ?? { name: "", org_type: "", logo_url: null, email_on_enroll: false, currency },
    });

    const bankAccounts = await fetchBankAccounts(supabase, result.tenant_id);

    return NextResponse.json(
      {
        enrollment_ref: result.enrollment_ref,
        items: result.items,
        quantity: result.quantity,
        total_fee: result.total_fee,
        fee_formatted: formatCurrency(result.total_fee, currency),
        payment: {
          instructions_en: `Please transfer ${formatCurrency(result.total_fee, currency)} to one of the bank accounts below and quote your enrollment reference "${result.enrollment_ref}" as the payment remark.`,
          instructions_mm: `ကျောင်းလခ ${formatCurrency(result.total_fee, currency)} ကို အောက်ပါ ဘဏ်အကောင့်များသို့ လွှဲပြောင်းပေးပြီး "${result.enrollment_ref}" ကို ငွေလွှဲမှတ်ချက်တွင် ထည့်သွင်းရေးသားပေးပါ။`,
          bank_accounts: bankAccounts,
        },
      },
      { status: 201 },
    );
  }

  // Single class enrollment
  const outcome = await createEnrollment({
    class_id: typeof class_id === "string" ? class_id : "",
    form_data: fd,
    idempotency_key: typeof idempotency_key === "string" ? idempotency_key : null,
    quantity: typeof quantity === "number" ? quantity : 1,
    messenger_psid: typeof messenger_psid === "string" ? messenger_psid : null,
    priority_token_hash: priorityTokenHash,
  });

  if (!outcome.ok) {
    const errBody: Record<string, unknown> = { error: outcome.error };
    if (outcome.error === "Validation Error") {
      errBody.messages = [outcome.message];
    } else {
      errBody.message = outcome.message;
      if (outcome.message_mm) errBody.message_mm = outcome.message_mm;
      if (outcome.extra) Object.assign(errBody, outcome.extra);
    }
    return NextResponse.json(errBody, { status: outcome.status });
  }

  const { result } = outcome;
  const tenantInfo = await fetchTenantInfo(supabase, result.tenant_id);
  const currency = tenantInfo?.currency ?? "MMK";

  sendEnrollmentConfirmationEmail({
    fd,
    enrollmentRef: result.enrollment_ref,
    classLevel: result.class_level,
    feeAmount: result.fee_amount * (result.quantity ?? 1),
    baseUrl: tenantLinkOrigin(tenantInfo?.subdomain),
    tenant: tenantInfo ?? { name: "", org_type: "", logo_url: null, email_on_enroll: false, currency },
  });

  const bankAccounts = await fetchBankAccounts(supabase, result.tenant_id);
  const enrolledQty = result.quantity ?? 1;
  const totalFee = result.fee_amount * enrolledQty;

  return NextResponse.json(
    {
      enrollment_ref: result.enrollment_ref,
      class_level: result.class_level,
      fee_amount: result.fee_amount,
      quantity: enrolledQty,
      total_fee: totalFee,
      fee_formatted: formatCurrency(totalFee, currency),
      payment: {
        instructions_en: `Please transfer ${formatCurrency(totalFee, currency)} to one of the bank accounts below and quote your enrollment reference "${result.enrollment_ref}" as the payment remark.`,
        instructions_mm: `ကျောင်းလခ ${formatCurrency(totalFee, currency)} ကို အောက်ပါ ဘဏ်အကောင့်များသို့ လွှဲပြောင်းပေးပြီး "${result.enrollment_ref}" ကို ငွေလွှဲမှတ်ချက်တွင် ထည့်သွင်းရေးသားပေးပါ။`,
        bank_accounts: bankAccounts,
      },
    },
    { status: 201 },
  );
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function fetchTenantInfo(supabase: ReturnType<typeof createAdminClient>, tenantId: string) {
  const { data } = await supabase
    .from("tenants")
    .select("name, org_type, logo_url, email_on_enroll, currency, subdomain")
    .eq("id", tenantId)
    .single() as {
    data: { name: string; org_type: string; logo_url: string | null; email_on_enroll: boolean; currency: string; subdomain: string | null } | null;
    error: unknown;
  };
  return data;
}

async function fetchBankAccounts(supabase: ReturnType<typeof createAdminClient>, tenantId: string) {
  const { data } = await supabase
    .from("bank_accounts")
    .select("bank_name, account_number, account_holder")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("bank_name") as {
    data: Pick<BankAccount, "bank_name" | "account_number" | "account_holder">[] | null;
  };
  return data ?? [];
}
