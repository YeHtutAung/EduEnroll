import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { formatCurrency, formatCurrencySimple, resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";
import { sendEmail, enrollmentConfirmationEmail } from "@/lib/email";
import type { BankAccount, SubmitEnrollmentResult, SubmitCartEnrollmentResult } from "@/types/database";

// ─── Validation helpers ───────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── POST /api/public/enroll ──────────────────────────────────────────────────
// Public — no authentication required.
//
// 1. Calls submit_enrollment(p_class_id) to atomically reserve a seat.
// 2. Updates the enrollment row with form_data + best-effort legacy columns.
//
// Request body:
// {
//   class_id:   string            (UUID, required)
//   form_data?: Record<string, string>  (dynamic form fields)
// }

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── Parse body ────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const { class_id, form_data, idempotency_key, quantity, items, messenger_psid, __hp } = body as Record<string, unknown>;

  // ── Honeypot check — return fake success to fool bots ──────────
  if (__hp && typeof __hp === "string" && __hp.trim().length > 0) {
    return NextResponse.json({ enrollment_ref: "OK-0000-0000" }, { status: 200 });
  }

  // ── Cart checkout (multiple ticket types) ───────────────────────
  if (Array.isArray(items)) {
    return handleCartEnrollment(request, tenantId, items, form_data, messenger_psid);
  }

  // ── Validate class_id ─────────────────────────────────────────
  if (!class_id || typeof class_id !== "string" || !UUID_RE.test(class_id)) {
    return NextResponse.json(
      { error: "Validation Error", messages: ["class_id must be a valid UUID."] },
      { status: 400 },
    );
  }

  // ── Call the atomic Postgres transaction (seat reservation) ───
  const supabase = createAdminClient();

  const idemKey = typeof idempotency_key === "string" ? idempotency_key : null;
  const qty = typeof quantity === "number" && quantity >= 1 ? Math.floor(quantity) : 1;

  const { data: result, error: rpcError } = await supabase.rpc(
    "submit_enrollment",
    { p_class_id: class_id, p_idempotency_key: idemKey, p_quantity: qty } as never,
  );

  if (rpcError) {
    console.error("[enroll] RPC error:", rpcError.message);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Enrollment failed. Please try again." },
      { status: 500 },
    );
  }

  const payload = result as SubmitEnrollmentResult;

  // ── Handle business-logic errors from the DB function ─────────
  if (!payload.success) {
    switch (payload.error) {
      case "CLASS_NOT_FOUND":
        return NextResponse.json(
          { error: "Not Found", message: "Class not found." },
          { status: 404 },
        );
      case "CLASS_NOT_OPEN":
        return NextResponse.json(
          {
            error:   "Class Unavailable",
            message: "This class is no longer accepting enrollments.",
            message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းမှု ပိတ်သိမ်းပြီးဖြစ်သည်။",
          },
          { status: 409 },
        );
      case "CLASS_FULL":
        return NextResponse.json(
          {
            error:   "Class Full",
            message: "Sorry, this class is now full. Please choose another level.",
            message_mm: "ဝမ်းနည်းပါသည်။ ဤသင်တန်းတွင် နေရာပြည့်သွားပြီဖြစ်သည်။ အခြားအဆင့်ကို ရွေးချယ်ပါ။",
          },
          { status: 409 },
        );
      case "NOT_ENOUGH_SEATS":
        return NextResponse.json(
          {
            error:   "Not Enough Seats",
            message: `Only ${payload.seat_remaining} ticket(s) remaining. Please reduce your quantity.`,
            message_mm: `လက်ကျန်လက်မှတ် ${payload.seat_remaining} ခုသာ ကျန်ပါသည်။ အရေအတွက် လျှော့ပါ။`,
          },
          { status: 409 },
        );
      case "EXCEEDS_MAX_TICKETS":
        return NextResponse.json(
          {
            error:   "Exceeds Limit",
            message: `Maximum ${payload.max} ticket(s) per person.`,
            message_mm: `တစ်ဦးလျှင် အများဆုံး လက်မှတ် ${payload.max} ခုသာ ဝယ်ယူနိုင်ပါသည်။`,
          },
          { status: 409 },
        );
      case "ENROLLMENT_NOT_OPEN":
        return NextResponse.json(
          {
            error:   "Enrollment Not Open",
            message: "Enrollment for this class has not opened yet.",
            message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် မရောက်သေးပါ။",
          },
          { status: 409 },
        );
      case "ENROLLMENT_CLOSED":
        return NextResponse.json(
          {
            error:   "Enrollment Closed",
            message: "Enrollment for this class has closed.",
            message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် ကုန်ဆုံးသွားပြီဖြစ်သည်။",
          },
          { status: 409 },
        );
      default:
        console.error("[enroll] DB error:", payload.detail);
        return NextResponse.json(
          { error: "Internal Server Error", message: "Enrollment failed. Please try again." },
          { status: 500 },
        );
    }
  }

  // ── Update enrollment with form_data + legacy columns ─────────
  const fd = (form_data && typeof form_data === "object") ? form_data as Record<string, string> : null;

  // Fetch field definitions to check types before legacy mapping + email
  let fieldTypeMap = new Map<string, string>();
  if (fd) {
    const { data: classRow } = await supabase
      .from("classes")
      .select("intake_id")
      .eq("id", class_id)
      .single() as { data: { intake_id: string } | null; error: unknown };

    const { data: fieldDefs } = await supabase
      .from("intake_form_fields")
      .select("field_key, field_type")
      .eq("intake_id", classRow?.intake_id ?? "") as { data: { field_key: string; field_type: string }[] | null; error: unknown };

    fieldTypeMap = new Map((fieldDefs ?? []).map((f) => [f.field_key, f.field_type]));

    const updatePayload: Record<string, unknown> = { form_data: fd };

    // Best-effort mapping: only populate legacy columns when field type matches expectations
    if (fd.name_en && fieldTypeMap.get("name_en") === "text")
      updatePayload.student_name_en = fd.name_en.trim();
    if (fd.name_mm && fieldTypeMap.get("name_mm") === "text")
      updatePayload.student_name_mm = fd.name_mm.trim();
    if (fd.phone && (fieldTypeMap.get("phone") === "phone" || fieldTypeMap.get("phone") === "text"))
      updatePayload.phone = fd.phone.trim();
    if (fd.email && (fieldTypeMap.get("email") === "text" || fieldTypeMap.get("email") === "email"))
      updatePayload.email = fd.email.trim();
    if (fd.nrc && fieldTypeMap.get("nrc") === "text")
      updatePayload.nrc_number = fd.nrc.trim();

    // Fallback: phone_number or custom_phone_* fields
    if (!updatePayload.phone) {
      const resolvedPhone = resolvePhoneFromFormData(fd);
      if (resolvedPhone) updatePayload.phone = resolvedPhone;
    }

    // Fallback: email_address or custom_email_* fields
    if (!updatePayload.email) {
      const resolvedEmail = resolveEmailFromFormData(fd);
      if (resolvedEmail) updatePayload.email = resolvedEmail;
    }

    // Store messenger PSID if enrollment came from chatbot
    if (typeof messenger_psid === "string" && messenger_psid.trim()) {
      updatePayload.messenger_psid = messenger_psid.trim();
    }

    await supabase
      .from("enrollments")
      .update(updatePayload as never)
      .eq("id", payload.enrollment_id);
  }

  // ── Fetch tenant info for currency + email branding ──────────
  const { data: tenantInfo } = await supabase
    .from("tenants")
    .select("name, org_type, logo_url, email_on_enroll, currency")
    .eq("id", payload.tenant_id)
    .single() as { data: { name: string; org_type: string; logo_url: string | null; email_on_enroll: boolean; currency: string } | null; error: unknown };

  const currency = tenantInfo?.currency ?? "MMK";

  // ── Send confirmation email (best-effort, non-blocking) ──────
  const recipientEmail = resolveEmailFromFormData(fd);
  if (recipientEmail && tenantInfo?.email_on_enroll) {
    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const baseUrl = `${proto}://${host}`;

    const emailData = enrollmentConfirmationEmail({
      studentName: fd?.name_en?.trim() || "Student",
      enrollmentRef: payload.enrollment_ref,
      classLevel: payload.class_level,
      feeAmount: payload.fee_amount,
      feeFormatted: formatCurrencySimple(payload.fee_amount, currency),
      paymentUrl: `${baseUrl}/enroll/payment/${payload.enrollment_ref}`,
      statusUrl: `${baseUrl}/status?ref=${payload.enrollment_ref}`,
      orgType: tenantInfo?.org_type,
      tenantName: tenantInfo?.name,
      logoUrl: tenantInfo?.logo_url ?? undefined,
    });

    sendEmail({ to: recipientEmail!, ...emailData }).catch((err) => {
      console.error("[enroll] Email send failed:", err);
    });
  }

  // ── Fetch active bank accounts for payment instructions ───────
  const { data: bankAccounts } = await supabase
    .from("bank_accounts")
    .select("bank_name, account_number, account_holder")
    .eq("tenant_id", payload.tenant_id)
    .eq("is_active", true)
    .order("bank_name") as { data: Pick<BankAccount, "bank_name" | "account_number" | "account_holder">[] | null };

  // ── Return success response ───────────────────────────────────
  const enrolledQty = payload.quantity ?? 1;
  const totalFee = payload.fee_amount * enrolledQty;

  return NextResponse.json(
    {
      enrollment_ref: payload.enrollment_ref,
      class_level:    payload.class_level,
      fee_amount:     payload.fee_amount,
      quantity:       enrolledQty,
      total_fee:      totalFee,
      fee_formatted:  formatCurrency(totalFee, currency),
      payment: {
        instructions_en:
          `Please transfer ${formatCurrency(totalFee, currency)} to one of the bank accounts below ` +
          `and quote your enrollment reference "${payload.enrollment_ref}" as the payment remark.`,
        instructions_mm:
          `ကျောင်းလခ ${formatCurrency(totalFee, currency)} ကို အောက်ပါ ဘဏ်အကောင့်များသို့ လွှဲပြောင်းပေးပြီး ` +
          `"${payload.enrollment_ref}" ကို ငွေလွှဲမှတ်ချက်တွင် ထည့်သွင်းရေးသားပေးပါ။`,
        bank_accounts: bankAccounts ?? [],
      },
    },
    { status: 201 },
  );
}

// ─── Cart enrollment handler ──────────────────────────────────────────────────

async function handleCartEnrollment(
  request: NextRequest,
  tenantId: string,
  items: unknown[],
  form_data: unknown,
  messenger_psid: unknown,
) {
  // Validate items array
  const validatedItems: { class_id: string; quantity: number }[] = [];
  for (const item of items) {
    const it = item as Record<string, unknown>;
    if (!it.class_id || typeof it.class_id !== "string" || !UUID_RE.test(it.class_id)) {
      return NextResponse.json(
        { error: "Validation Error", messages: ["Each item must have a valid class_id UUID."] },
        { status: 400 },
      );
    }
    const qty = typeof it.quantity === "number" && it.quantity >= 1 ? Math.floor(it.quantity) : 1;
    validatedItems.push({ class_id: it.class_id, quantity: qty });
  }

  if (validatedItems.length === 0) {
    return NextResponse.json(
      { error: "Validation Error", messages: ["Cart must have at least one item."] },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  const { data: result, error: rpcError } = await supabase.rpc(
    "submit_cart_enrollment",
    { p_items: validatedItems } as never,
  );

  if (rpcError) {
    console.error("[enroll/cart] RPC error:", rpcError.message);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Enrollment failed. Please try again." },
      { status: 500 },
    );
  }

  const payload = result as SubmitCartEnrollmentResult;

  if (!payload.success) {
    const levelHint = payload.class_level ? ` (${payload.class_level})` : "";
    switch (payload.error) {
      case "EMPTY_CART":
        return NextResponse.json(
          { error: "Validation Error", message: "Cart is empty." },
          { status: 400 },
        );
      case "CLASS_NOT_FOUND":
        return NextResponse.json(
          { error: "Not Found", message: `Ticket type not found${levelHint}.` },
          { status: 404 },
        );
      case "CLASS_NOT_OPEN":
        return NextResponse.json(
          { error: "Ticket Unavailable", message: `${payload.class_level} is no longer available.` },
          { status: 409 },
        );
      case "NOT_ENOUGH_SEATS":
        return NextResponse.json(
          {
            error: "Not Enough Seats",
            message: `Only ${payload.seat_remaining} ticket(s) remaining for ${payload.class_level}.`,
          },
          { status: 409 },
        );
      case "EXCEEDS_MAX_TICKETS":
        return NextResponse.json(
          {
            error: "Exceeds Limit",
            message: `Maximum ${payload.max} ticket(s) per person for ${payload.class_level}.`,
          },
          { status: 409 },
        );
      case "ENROLLMENT_NOT_OPEN":
        return NextResponse.json(
          { error: "Enrollment Not Open", message: `Ticket sales for ${payload.class_level} have not opened yet.` },
          { status: 409 },
        );
      case "ENROLLMENT_CLOSED":
        return NextResponse.json(
          { error: "Enrollment Closed", message: `Ticket sales for ${payload.class_level} have closed.` },
          { status: 409 },
        );
      default:
        console.error("[enroll/cart] DB error:", payload.detail);
        return NextResponse.json(
          { error: "Internal Server Error", message: "Enrollment failed. Please try again." },
          { status: 500 },
        );
    }
  }

  // ── Update enrollment with form_data + legacy columns ─────────
  const fd = form_data && typeof form_data === "object" ? (form_data as Record<string, string>) : null;

  let fieldTypeMap = new Map<string, string>();
  if (fd) {
    // Get intake_id from first item's class
    const firstClassId = payload.items[0]?.class_id;
    if (firstClassId) {
      const { data: classRow } = await supabase
        .from("classes")
        .select("intake_id")
        .eq("id", firstClassId)
        .single() as { data: { intake_id: string } | null; error: unknown };

      const { data: fieldDefs } = await supabase
        .from("intake_form_fields")
        .select("field_key, field_type")
        .eq("intake_id", classRow?.intake_id ?? "") as {
        data: { field_key: string; field_type: string }[] | null;
        error: unknown;
      };

      fieldTypeMap = new Map((fieldDefs ?? []).map((f) => [f.field_key, f.field_type]));
    }

    const updatePayload: Record<string, unknown> = { form_data: fd };

    if (fd.name_en && fieldTypeMap.get("name_en") === "text")
      updatePayload.student_name_en = fd.name_en.trim();
    if (fd.name_mm && fieldTypeMap.get("name_mm") === "text")
      updatePayload.student_name_mm = fd.name_mm.trim();
    if (fd.phone && (fieldTypeMap.get("phone") === "phone" || fieldTypeMap.get("phone") === "text"))
      updatePayload.phone = fd.phone.trim();
    if (fd.email && (fieldTypeMap.get("email") === "text" || fieldTypeMap.get("email") === "email"))
      updatePayload.email = fd.email.trim();
    if (fd.nrc && fieldTypeMap.get("nrc") === "text")
      updatePayload.nrc_number = fd.nrc.trim();

    // Fallback: phone_number or custom_phone_* fields
    if (!updatePayload.phone) {
      const resolvedPhone = resolvePhoneFromFormData(fd);
      if (resolvedPhone) updatePayload.phone = resolvedPhone;
    }

    // Fallback: email_address or custom_email_* fields
    if (!updatePayload.email) {
      const resolvedEmail = resolveEmailFromFormData(fd);
      if (resolvedEmail) updatePayload.email = resolvedEmail;
    }

    // Store messenger PSID if enrollment came from chatbot
    if (typeof messenger_psid === "string" && messenger_psid.trim()) {
      updatePayload.messenger_psid = messenger_psid.trim();
    }

    await supabase.from("enrollments").update(updatePayload as never).eq("id", payload.enrollment_id);
  }

  // ── Fetch tenant info for currency + email branding ──────────
  const { data: cartTenantInfo } = await supabase
    .from("tenants")
    .select("name, org_type, logo_url, email_on_enroll, currency")
    .eq("id", payload.tenant_id)
    .single() as { data: { name: string; org_type: string; logo_url: string | null; email_on_enroll: boolean; currency: string } | null; error: unknown };

  const cartCurrency = cartTenantInfo?.currency ?? "MMK";

  // ── Send confirmation email ────────────────────────────────────
  const cartRecipientEmail = resolveEmailFromFormData(fd);
  if (cartRecipientEmail && cartTenantInfo?.email_on_enroll) {
    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const baseUrl = `${proto}://${host}`;

    const itemsSummary = payload.items
      .map((i) => i.quantity > 1 ? `${i.class_level} x${i.quantity}` : i.class_level)
      .join(", ");
    const emailData = enrollmentConfirmationEmail({
      studentName: fd?.name_en?.trim() || "Student",
      enrollmentRef: payload.enrollment_ref,
      classLevel: itemsSummary,
      feeAmount: payload.total_fee,
      feeFormatted: formatCurrencySimple(payload.total_fee, cartCurrency),
      paymentUrl: `${baseUrl}/enroll/payment/${payload.enrollment_ref}`,
      statusUrl: `${baseUrl}/status?ref=${payload.enrollment_ref}`,
      orgType: cartTenantInfo?.org_type,
      tenantName: cartTenantInfo?.name,
      logoUrl: cartTenantInfo?.logo_url ?? undefined,
    });

    sendEmail({ to: cartRecipientEmail!, ...emailData }).catch((err) => {
      console.error("[enroll/cart] Email send failed:", err);
    });
  }

  // ── Fetch bank accounts ────────────────────────────────────────
  const { data: bankAccounts } = await supabase
    .from("bank_accounts")
    .select("bank_name, account_number, account_holder")
    .eq("tenant_id", payload.tenant_id)
    .eq("is_active", true)
    .order("bank_name") as {
    data: Pick<BankAccount, "bank_name" | "account_number" | "account_holder">[] | null;
  };

  return NextResponse.json(
    {
      enrollment_ref: payload.enrollment_ref,
      items: payload.items,
      quantity: payload.quantity,
      total_fee: payload.total_fee,
      fee_formatted: formatCurrency(payload.total_fee, cartCurrency),
      payment: {
        instructions_en:
          `Please transfer ${formatCurrency(payload.total_fee, cartCurrency)} to one of the bank accounts below ` +
          `and quote your enrollment reference "${payload.enrollment_ref}" as the payment remark.`,
        instructions_mm:
          `ကျောင်းလခ ${formatCurrency(payload.total_fee, cartCurrency)} ကို အောက်ပါ ဘဏ်အကောင့်များသို့ လွှဲပြောင်းပေးပြီး ` +
          `"${payload.enrollment_ref}" ကို ငွေလွှဲမှတ်ချက်တွင် ထည့်သွင်းရေးသားပေးပါ။`,
        bank_accounts: bankAccounts ?? [],
      },
    },
    { status: 201 },
  );
}
