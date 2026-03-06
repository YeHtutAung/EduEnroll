// ─── Messenger bot response handlers ─────────────────────────────────────────

import { createAdminClient } from "@/lib/supabase/admin";
import { formatMMK } from "@/lib/utils";
import { sendTextMessage, sendQuickReplies } from "./send";
import type { Enrollment, Class, Payment, BankAccount } from "@/types/database";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MM_DIGITS: Record<string, string> = {
  "0": "၀", "1": "၁", "2": "၂", "3": "၃", "4": "၄",
  "5": "၅", "6": "၆", "7": "၇", "8": "၈", "9": "၉",
};

function toMM(str: string): string {
  return str.replace(/[0-9]/g, (d) => MM_DIGITS[d]);
}

const MONTH_MM: Record<number, string> = {
  0: "ဇန်နဝါရီ", 1: "ဖေဖော်ဝါရီ", 2: "မတ်", 3: "ဧပြီ",
  4: "မေ", 5: "ဇွန်", 6: "ဇူလိုင်", 7: "ဩဂုတ်",
  8: "စက်တင်ဘာ", 9: "အောက်တိုဘာ", 10: "နိုဝင်ဘာ", 11: "ဒီဇင်ဘာ",
};

function formatDateMM(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const month = MONTH_MM[d.getMonth()] ?? "";
  const year = d.getFullYear();
  return `${toMM(String(day))} ${month} ${toMM(String(year))}`;
}

function formatDateEN(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function intakeToSlug(name: string, year: number): string {
  const monthMatch = name.match(/january|february|march|april|may|june|july|august|september|october|november|december/i);
  const month = monthMatch ? monthMatch[0].toLowerCase() : name.toLowerCase().replace(/\s+/g, "-");
  return `${month}-${year}`;
}

const MAIN_MENU_BUTTONS = [
  { content_type: "text" as const, title: "📚 Open Intakes", payload: "OPEN_INTAKES" },
  { content_type: "text" as const, title: "💰 Fees", payload: "FEES" },
  { content_type: "text" as const, title: "📝 How to Enroll", payload: "HOW_TO_ENROLL" },
  { content_type: "text" as const, title: "📅 Schedule", payload: "SCHEDULE" },
  { content_type: "text" as const, title: "🏦 Payment", payload: "PAYMENT" },
  { content_type: "text" as const, title: "📋 Check Status", payload: "CHECK_STATUS" },
];

const STATUS_LABELS: Record<string, { en: string; mm: string }> = {
  pending_payment: { en: "Awaiting Payment", mm: "ငွေပေးချေမှု စောင့်ဆိုင်းဆဲ" },
  payment_submitted: { en: "Payment Under Review", mm: "ငွေပေးချေမှု စစ်ဆေးနေဆဲ" },
  confirmed: { en: "Enrollment Confirmed ✅", mm: "စာရင်းသွင်းမှု အတည်ပြုပြီး ✅" },
  rejected: { en: "Enrollment Rejected ❌", mm: "စာရင်းသွင်းမှု ငြင်းဆိုထားသည် ❌" },
};

// ─── 1. Welcome ──────────────────────────────────────────────────────────────

export async function sendWelcome(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("name")
    .eq("id", tenantId)
    .single() as { data: { name: string } | null; error: unknown };

  const school = tenant?.name ?? "KuuNyi";

  await sendQuickReplies(
    pageToken,
    senderPsid,
    `မင်္ဂလာပါ! ${school} မှ ကြိုဆိုပါတယ် 🎌\nHello! Welcome to ${school}\n\nHow can I help you?\nဘာကူညီပေးရမလဲ?`,
    MAIN_MENU_BUTTONS,
  );
}

// ─── 2. Open Intakes ─────────────────────────────────────────────────────────

export async function sendOpenIntakes(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: intakes } = await supabase
    .from("intakes")
    .select("id, name, year")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .order("year", { ascending: true }) as {
    data: { id: string; name: string; year: number }[] | null;
    error: unknown;
  };

  if (!intakes || intakes.length === 0) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      "လောလောဆယ် ဖွင့်လှစ်ထားသော သင်တန်းမရှိပါ\nNo open intakes currently.\n\nPlease check back later!",
    );
    return;
  }

  let msg = "📚 ဖွင့်လှစ်ထားသော သင်တန်းများ / Open Intakes\n\n";

  for (const intake of intakes) {
    const { data: classes } = await supabase
      .from("classes")
      .select("level, seat_remaining")
      .eq("intake_id", intake.id)
      .eq("tenant_id", tenantId)
      .in("status", ["open", "full"])
      .order("level") as {
      data: { level: string; seat_remaining: number }[] | null;
      error: unknown;
    };

    const levels = (classes ?? []).map((c) =>
      c.seat_remaining > 0 ? c.level : `${c.level} (Full)`,
    );

    msg += `🎓 ${intake.name}\n`;
    msg += `   Levels: ${levels.join(", ") || "—"}\n\n`;
  }

  await sendQuickReplies(pageToken, senderPsid, msg.trim(), [
    { content_type: "text", title: "📝 How to Enroll", payload: "HOW_TO_ENROLL" },
    { content_type: "text", title: "💰 Fees", payload: "FEES" },
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ]);
}

// ─── 3. Fees ─────────────────────────────────────────────────────────────────

export async function sendFees(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  // Find the latest open intake
  const { data: intake } = await supabase
    .from("intakes")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .order("year", { ascending: false })
    .limit(1)
    .single() as { data: { id: string; name: string } | null; error: unknown };

  if (!intake) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      "လောလောဆယ် သင်တန်းကြေး သတင်းအချက်အလက် မရှိပါ\nNo fee information available currently.",
    );
    return;
  }

  const { data: classes } = await supabase
    .from("classes")
    .select("level, fee_mmk")
    .eq("intake_id", intake.id)
    .eq("tenant_id", tenantId)
    .in("status", ["open", "full"])
    .order("level") as {
    data: Pick<Class, "level" | "fee_mmk">[] | null;
    error: unknown;
  };

  if (!classes || classes.length === 0) {
    await sendTextMessage(pageToken, senderPsid, "No classes found for this intake.");
    return;
  }

  // Sort N5→N1
  const LEVEL_ORDER = ["N5", "N4", "N3", "N2", "N1"];
  classes.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));

  let msg = `💰 သင်တန်းကြေးများ / Course Fees\n📋 ${intake.name}\n\n`;
  for (const c of classes) {
    msg += `${c.level}: ${formatMMK(c.fee_mmk)}\n`;
  }

  await sendQuickReplies(pageToken, senderPsid, msg.trim(), [
    { content_type: "text", title: "📝 How to Enroll", payload: "HOW_TO_ENROLL" },
    { content_type: "text", title: "🏦 Payment", payload: "PAYMENT" },
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ]);
}

// ─── 4. Enroll Link ──────────────────────────────────────────────────────────

export async function sendEnrollLink(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("subdomain")
    .eq("id", tenantId)
    .single() as { data: { subdomain: string } | null; error: unknown };

  const { data: intake } = await supabase
    .from("intakes")
    .select("name, year")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .order("year", { ascending: false })
    .limit(1)
    .single() as { data: { name: string; year: number } | null; error: unknown };

  if (!tenant || !intake) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      "လောလောဆယ် စာရင်းသွင်းလို့ မရပါသေး\nNo open enrollment available currently.",
    );
    return;
  }

  const slug = intakeToSlug(intake.name, intake.year);
  const url = `https://${tenant.subdomain}.kuunyi.com/enroll/${slug}`;

  await sendTextMessage(
    pageToken,
    senderPsid,
    `စာရင်းသွင်းရန် / To enroll:\n👉 ${url}\n\n` +
      `အထက်ပါ link ကိုနှိပ်ပြီး လိုအပ်သော အချက်အလက်များ ဖြည့်ပါ။\nClick the link above and fill in the required information.`,
  );
}

// ─── 5. Schedule ─────────────────────────────────────────────────────────────

export async function sendSchedule(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: intake } = await supabase
    .from("intakes")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .order("year", { ascending: false })
    .limit(1)
    .single() as { data: { id: string; name: string } | null; error: unknown };

  if (!intake) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      "လောလောဆယ် အချိန်ဇယား မရှိပါ\nNo schedule information available currently.",
    );
    return;
  }

  const { data: classes } = await supabase
    .from("classes")
    .select("level, enrollment_open_at, enrollment_close_at, status")
    .eq("intake_id", intake.id)
    .eq("tenant_id", tenantId)
    .in("status", ["open", "full"])
    .order("level") as {
    data: Pick<Class, "level" | "enrollment_open_at" | "enrollment_close_at" | "status">[] | null;
    error: unknown;
  };

  if (!classes || classes.length === 0) {
    await sendTextMessage(pageToken, senderPsid, "No schedule info for this intake.");
    return;
  }

  const LEVEL_ORDER = ["N5", "N4", "N3", "N2", "N1"];
  classes.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));

  let msg = `📅 စာရင်းသွင်းချိန် / Enrollment Schedule\n📋 ${intake.name}\n\n`;

  for (const c of classes) {
    msg += `${c.level}:\n`;
    if (c.enrollment_open_at) {
      msg += `  Open: ${formatDateEN(c.enrollment_open_at)} / ${formatDateMM(c.enrollment_open_at)}\n`;
    }
    if (c.enrollment_close_at) {
      msg += `  Close: ${formatDateEN(c.enrollment_close_at)} / ${formatDateMM(c.enrollment_close_at)}\n`;
    }
    if (!c.enrollment_open_at && !c.enrollment_close_at) {
      msg += `  No dates set\n`;
    }
    msg += "\n";
  }

  await sendQuickReplies(pageToken, senderPsid, msg.trim(), [
    { content_type: "text", title: "📝 How to Enroll", payload: "HOW_TO_ENROLL" },
    { content_type: "text", title: "💰 Fees", payload: "FEES" },
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ]);
}

// ─── 6. Payment Info ─────────────────────────────────────────────────────────

export async function sendPaymentInfo(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: accounts } = await supabase
    .from("bank_accounts")
    .select("bank_name, account_number, account_holder")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("bank_name") as {
    data: Pick<BankAccount, "bank_name" | "account_number" | "account_holder">[] | null;
    error: unknown;
  };

  const { data: tenant } = await supabase
    .from("tenants")
    .select("subdomain")
    .eq("id", tenantId)
    .single() as { data: { subdomain: string } | null; error: unknown };

  if (!accounts || accounts.length === 0) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      "ဘဏ်အကောင့် အချက်အလက် မရှိသေးပါ\nNo bank account info available. Please contact the school.",
    );
    return;
  }

  let msg = "🏦 ငွေပေးချေရန် / Payment Information\n\n";

  for (const acc of accounts) {
    msg += `${acc.bank_name} Bank\n`;
    msg += `  Account: ${acc.account_number}\n`;
    msg += `  Name: ${acc.account_holder}\n\n`;
  }

  msg += "ငွေလွှဲပြီးပါက ငွေလွှဲပြေစာ ဓာတ်ပုံ upload လုပ်ပါ။\nAfter transfer, upload your payment proof.";

  if (tenant?.subdomain) {
    msg += `\n\n📤 Upload: https://${tenant.subdomain}.kuunyi.com/status`;
  }

  await sendQuickReplies(pageToken, senderPsid, msg.trim(), [
    { content_type: "text", title: "📋 Check Status", payload: "CHECK_STATUS" },
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ]);
}

// ─── 7. Status Check ─────────────────────────────────────────────────────────

export async function sendStatusCheck(
  tenantId: string,
  senderPsid: string,
  ref: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("*, classes(level, fee_mmk)")
    .eq("enrollment_ref", ref)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: (Enrollment & { classes: Pick<Class, "level" | "fee_mmk"> | null }) | null;
    error: unknown;
  };

  if (!enrollment) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      `Reference number မတွေ့ပါ / Reference number not found.\n\n"${ref}" ဖြင့် စာရင်းသွင်းမှု ရှာမတွေ့ပါ။\nNo enrollment found for "${ref}".\n\nPlease check and try again.`,
    );
    return;
  }

  const statusLabel = STATUS_LABELS[enrollment.status] ?? {
    en: enrollment.status,
    mm: enrollment.status,
  };

  let reply =
    `📋 Enrollment Status / စာရင်းသွင်းမှု အခြေအနေ\n\n` +
    `Ref: ${enrollment.enrollment_ref}\n` +
    `Name / အမည်: ${enrollment.student_name_en}`;

  if (enrollment.student_name_mm) {
    reply += ` (${enrollment.student_name_mm})`;
  }
  reply += "\n";

  if (enrollment.classes) {
    reply += `Level / အဆင့်: JLPT ${enrollment.classes.level}\n`;
    reply += `Fee / ကြေး: ${formatMMK(enrollment.classes.fee_mmk)}\n`;
  }

  reply += `\nStatus: ${statusLabel.en}\nအခြေအနေ: ${statusLabel.mm}`;

  // Check latest payment
  const { data: payment } = (await supabase
    .from("payments")
    .select("status")
    .eq("enrollment_id", enrollment.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()) as { data: Pick<Payment, "status"> | null; error: unknown };

  if (payment) {
    const payLabel: Record<string, string> = {
      pending: "⏳ Pending / အတည်ပြုမှု စောင့်ဆိုင်းဆဲ",
      verified: "✅ Verified / အတည်ပြုပြီး",
      rejected: "❌ Rejected / ငြင်းဆိုထားသည်",
    };
    reply += `\n\n💰 Payment: ${payLabel[payment.status] ?? payment.status}`;
  }

  await sendQuickReplies(pageToken, senderPsid, reply, [
    { content_type: "text", title: "🔄 Check Another", payload: "CHECK_STATUS" },
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ]);
}
