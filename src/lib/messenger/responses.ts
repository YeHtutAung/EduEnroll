// ─── Messenger bot response handlers ─────────────────────────────────────────

import { createAdminClient } from "@/lib/supabase/admin";
import { formatMMK } from "@/lib/utils";
import { sendTextMessage, sendQuickReplies } from "./send";
import type { Enrollment, Class, Payment, BankAccount, MenuButton } from "@/types/database";

// ─── Org type ────────────────────────────────────────────────────────────────

type OrgType = "language_school" | "event" | "training_center";

// ─── Org-aware labels ────────────────────────────────────────────────────────

const ORG_LABELS: Record<OrgType, {
  menuButtons: { title: string; payload: string }[];
  welcomeEmoji: string;
  openIntakesTitle: { en: string; mm: string };
  openIntakesEmpty: { en: string; mm: string };
  intakeEmoji: string;
  classLabel: string;
  feesTitle: { en: string; mm: string };
  feesEmpty: { en: string; mm: string };
  enrollTitle: { en: string; mm: string };
  enrollEmpty: { en: string; mm: string };
  enrollAction: { en: string; mm: string };
  scheduleTitle: { en: string; mm: string };
  scheduleEmpty: { en: string; mm: string };
  levelPrefix: string;
  statusLevelLabel: { en: string; mm: string };
  statusFeeLabel: { en: string; mm: string };
  contactFallback: string;
}> = {
  language_school: {
    menuButtons: [
      { title: "📚 Open Intakes", payload: "OPEN_INTAKES" },
      { title: "💰 Fees", payload: "FEES" },
      { title: "📝 How to Enroll", payload: "HOW_TO_ENROLL" },
      { title: "📅 Schedule", payload: "SCHEDULE" },
      { title: "🏦 Payment", payload: "PAYMENT" },
      { title: "📋 Check Status", payload: "CHECK_STATUS" },
      { title: "💬 Live Agent", payload: "LIVE_AGENT" },
    ],
    welcomeEmoji: "🎌",
    openIntakesTitle: { en: "Open Intakes", mm: "ဖွင့်လှစ်ထားသော သင်တန်းများ" },
    openIntakesEmpty: { en: "No open intakes currently.", mm: "လောလောဆယ် ဖွင့်လှစ်ထားသော သင်တန်းမရှိပါ" },
    intakeEmoji: "🎓",
    classLabel: "Levels",
    feesTitle: { en: "Course Fees", mm: "သင်တန်းကြေးများ" },
    feesEmpty: { en: "No fee information available currently.", mm: "လောလောဆယ် သင်တန်းကြေး သတင်းအချက်အလက် မရှိပါ" },
    enrollTitle: { en: "To enroll", mm: "စာရင်းသွင်းရန်" },
    enrollEmpty: { en: "No open enrollment available currently.", mm: "လောလောဆယ် စာရင်းသွင်းလို့ မရပါသေး" },
    enrollAction: { en: "Click the link above and fill in the required information.", mm: "အထက်ပါ link ကိုနှိပ်ပြီး လိုအပ်သော အချက်အလက်များ ဖြည့်ပါ။" },
    scheduleTitle: { en: "Enrollment Schedule", mm: "စာရင်းသွင်းချိန်" },
    scheduleEmpty: { en: "No schedule information available currently.", mm: "လောလောဆယ် အချိန်ဇယား မရှိပါ" },
    levelPrefix: "JLPT ",
    statusLevelLabel: { en: "Level", mm: "အဆင့်" },
    statusFeeLabel: { en: "Fee", mm: "ကြေး" },
    contactFallback: "Please contact the school.",
  },
  event: {
    menuButtons: [
      { title: "🎪 Events", payload: "OPEN_INTAKES" },
      { title: "🎫 Tickets", payload: "FEES" },
      { title: "📝 Register", payload: "HOW_TO_ENROLL" },
      { title: "📅 Event Date", payload: "SCHEDULE" },
      { title: "🏦 Payment", payload: "PAYMENT" },
      { title: "📋 Check Status", payload: "CHECK_STATUS" },
      { title: "💬 Live Agent", payload: "LIVE_AGENT" },
    ],
    welcomeEmoji: "🎉",
    openIntakesTitle: { en: "Upcoming Events", mm: "လာမည့် ပွဲများ" },
    openIntakesEmpty: { en: "No upcoming events currently.", mm: "လောလောဆယ် လာမည့်ပွဲ မရှိပါ" },
    intakeEmoji: "🎪",
    classLabel: "Ticket Types",
    feesTitle: { en: "Ticket Prices", mm: "လက်မှတ်စျေးနှုန်းများ" },
    feesEmpty: { en: "No ticket information available currently.", mm: "လောလောဆယ် လက်မှတ်စျေးနှုန်း မရှိပါ" },
    enrollTitle: { en: "To register", mm: "မှတ်ပုံတင်ရန်" },
    enrollEmpty: { en: "No open registration available currently.", mm: "လောလောဆယ် မှတ်ပုံတင်လို့ မရပါသေး" },
    enrollAction: { en: "Click the link above and fill in the required information.", mm: "အထက်ပါ link ကိုနှိပ်ပြီး လိုအပ်သော အချက်အလက်များ ဖြည့်ပါ။" },
    scheduleTitle: { en: "Event Schedule", mm: "ပွဲအချိန်ဇယား" },
    scheduleEmpty: { en: "No event schedule available currently.", mm: "လောလောဆယ် ပွဲအချိန်ဇယား မရှိပါ" },
    levelPrefix: "",
    statusLevelLabel: { en: "Ticket Type", mm: "လက်မှတ်အမျိုးအစား" },
    statusFeeLabel: { en: "Price", mm: "စျေးနှုန်း" },
    contactFallback: "Please contact us.",
  },
  training_center: {
    menuButtons: [
      { title: "📚 Courses", payload: "OPEN_INTAKES" },
      { title: "💰 Fees", payload: "FEES" },
      { title: "📝 Enroll", payload: "HOW_TO_ENROLL" },
      { title: "📅 Schedule", payload: "SCHEDULE" },
      { title: "🏦 Payment", payload: "PAYMENT" },
      { title: "📋 Check Status", payload: "CHECK_STATUS" },
      { title: "💬 Live Agent", payload: "LIVE_AGENT" },
    ],
    welcomeEmoji: "📖",
    openIntakesTitle: { en: "Open Courses", mm: "ဖွင့်လှစ်ထားသော သင်တန်းများ" },
    openIntakesEmpty: { en: "No open courses currently.", mm: "လောလောဆယ် ဖွင့်လှစ်ထားသော သင်တန်းမရှိပါ" },
    intakeEmoji: "📖",
    classLabel: "Courses",
    feesTitle: { en: "Course Fees", mm: "သင်တန်းကြေးများ" },
    feesEmpty: { en: "No fee information available currently.", mm: "လောလောဆယ် သင်တန်းကြေး သတင်းအချက်အလက် မရှိပါ" },
    enrollTitle: { en: "To enroll", mm: "စာရင်းသွင်းရန်" },
    enrollEmpty: { en: "No open enrollment available currently.", mm: "လောလောဆယ် စာရင်းသွင်းလို့ မရပါသေး" },
    enrollAction: { en: "Click the link above and fill in the required information.", mm: "အထက်ပါ link ကိုနှိပ်ပြီး လိုအပ်သော အချက်အလက်များ ဖြည့်ပါ။" },
    scheduleTitle: { en: "Enrollment Schedule", mm: "စာရင်းသွင်းချိန်" },
    scheduleEmpty: { en: "No schedule information available currently.", mm: "လောလောဆယ် အချိန်ဇယား မရှိပါ" },
    levelPrefix: "",
    statusLevelLabel: { en: "Course", mm: "သင်တန်း" },
    statusFeeLabel: { en: "Fee", mm: "ကြေး" },
    contactFallback: "Please contact us.",
  },
};

function getLabels(orgType: string) {
  return ORG_LABELS[(orgType as OrgType)] ?? ORG_LABELS.language_school;
}

function getMenuButtons(orgType: string, customButtons?: MenuButton[] | null) {
  if (customButtons && customButtons.length > 0) {
    return customButtons
      .filter((b) => b.visible)
      .map((b) => ({ content_type: "text" as const, title: b.title, payload: b.key }));
  }
  const l = getLabels(orgType);
  return l.menuButtons.map((b) => ({ content_type: "text" as const, ...b }));
}

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

function intakeToSlug(slug: string | null, name: string, year: number): string {
  if (slug) return slug;
  const monthMatch = name.match(/january|february|march|april|may|june|july|august|september|october|november|december/i);
  const month = monthMatch ? monthMatch[0].toLowerCase() : name.toLowerCase().replace(/\s+/g, "-");
  return `${month}-${year}`;
}

async function getTenantInfo(tenantId: string): Promise<{ orgType: string; menuButtons: MenuButton[] | null }> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tenants")
    .select("org_type, menu_buttons")
    .eq("id", tenantId)
    .single() as { data: { org_type: string; menu_buttons: MenuButton[] | null } | null; error: unknown };
  return {
    orgType: data?.org_type ?? "language_school",
    menuButtons: data?.menu_buttons ?? null,
  };
}

const STATUS_LABELS: Record<OrgType, Record<string, { en: string; mm: string; enPay: string; mmPay: string }>> = {
  language_school: {
    pending_payment: { en: "Awaiting Payment", mm: "ငွေပေးချေမှု စောင့်ဆိုင်းဆဲ", enPay: "Pending", mmPay: "စောင့်ဆိုင်းဆဲ" },
    payment_submitted: { en: "Payment Under Review", mm: "ငွေပေးချေမှု စစ်ဆေးနေဆဲ", enPay: "Under review", mmPay: "အတည်ပြုနေဆဲ" },
    confirmed: { en: "Enrollment Confirmed ✅", mm: "စာရင်းသွင်းမှု အတည်ပြုပြီး ✅", enPay: "Verified", mmPay: "အတည်ပြုပြီး" },
    rejected: { en: "Enrollment Rejected ❌", mm: "စာရင်းသွင်းမှု ငြင်းဆိုထားသည် ❌", enPay: "Failed", mmPay: "မအောင်မြင်ပါ" },
  },
  event: {
    pending_payment: { en: "Ticket purchase under review", mm: "လက်မှတ်ဝယ်ယူမှု အတည်ပြုနေဆဲ", enPay: "Under review", mmPay: "အတည်ပြုနေဆဲ" },
    payment_submitted: { en: "Ticket purchase under review", mm: "လက်မှတ်ဝယ်ယူမှု အတည်ပြုနေဆဲ", enPay: "Under review", mmPay: "အတည်ပြုနေဆဲ" },
    confirmed: { en: "Ticket Order Successful", mm: "လက်မှတ်ဝယ်ယူမှု အောင်မြင်ပါပြီ", enPay: "Successful", mmPay: "အောင်မြင်ပါပြီ" },
    rejected: { en: "Ticket Order Failed", mm: "လက်မှတ်ဝယ်ယူမှု မအောင်မြင်ပါ", enPay: "Failed", mmPay: "မအောင်မြင်ပါပြီ" },
  },
  training_center: {
    pending_payment: { en: "Awaiting Payment", mm: "ငွေပေးချေမှု စောင့်ဆိုင်းဆဲ", enPay: "Pending", mmPay: "စောင့်ဆိုင်းဆဲ" },
    payment_submitted: { en: "Payment Under Review", mm: "ငွေပေးချေမှု စစ်ဆေးနေဆဲ", enPay: "Under review", mmPay: "အတည်ပြုနေဆဲ" },
    confirmed: { en: "Enrollment Confirmed ✅", mm: "စာရင်းသွင်းမှု အတည်ပြုပြီး ✅", enPay: "Verified", mmPay: "အတည်ပြုပြီး" },
    rejected: { en: "Enrollment Rejected ❌", mm: "စာရင်းသွင်းမှု ငြင်းဆိုထားသည် ❌", enPay: "Failed", mmPay: "မအောင်မြင်ပါ" },
  },
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
    .select("name, messenger_greeting, org_type, menu_buttons")
    .eq("id", tenantId)
    .single() as {
    data: { name: string; messenger_greeting: string | null; org_type: string; menu_buttons: MenuButton[] | null } | null;
    error: unknown;
  };

  const orgType = tenant?.org_type ?? "language_school";
  const customButtons = tenant?.menu_buttons ?? null;
  const l = getLabels(orgType);
  const school = tenant?.name ?? "KuuNyi";

  let msg: string;

  if (tenant?.messenger_greeting) {
    // Fully custom greeting replaces the default template
    msg = tenant.messenger_greeting;
  } else {
    msg = `မင်္ဂလာပါ! ${school} မှ ကြိုဆိုပါတယ် ${l.welcomeEmoji}\nHello! Welcome to ${school}`;
    msg += `\n\nဘာကူညီပေးရမလဲ? / How can I help you?`;
  }

  await sendQuickReplies(pageToken, senderPsid, msg, getMenuButtons(orgType, customButtons));
}

// ─── 2. Open Intakes ─────────────────────────────────────────────────────────

export async function sendOpenIntakes(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { orgType, menuButtons: customButtons } = await getTenantInfo(tenantId);
  const l = getLabels(orgType);

  const { data: intakes } = await supabase
    .from("intakes")
    .select("id, name, year, slug")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .order("year", { ascending: true }) as {
    data: { id: string; name: string; year: number; slug: string | null }[] | null;
    error: unknown;
  };

  if (!intakes || intakes.length === 0) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      `${l.openIntakesEmpty.mm}\n${l.openIntakesEmpty.en}\n\nPlease check back later!`,
    );
    return;
  }

  let msg = `📚 ${l.openIntakesTitle.mm} / ${l.openIntakesTitle.en}\n\n`;

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

    msg += `${l.intakeEmoji} ${intake.name}\n`;
    msg += `   ${l.classLabel}: ${levels.join(", ") || "—"}\n\n`;
  }

  const buttons = getMenuButtons(orgType, customButtons);
  await sendQuickReplies(pageToken, senderPsid, msg.trim(), [
    buttons.find((b) => b.payload === "HOW_TO_ENROLL")!,
    buttons.find((b) => b.payload === "FEES")!,
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ].filter((b): b is { content_type: "text"; title: string; payload: string } => !!b));
}

// ─── 3. Fees ─────────────────────────────────────────────────────────────────

export async function sendFees(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { orgType, menuButtons: customButtons } = await getTenantInfo(tenantId);
  const l = getLabels(orgType);

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
      `${l.feesEmpty.mm}\n${l.feesEmpty.en}`,
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
    await sendTextMessage(pageToken, senderPsid, `No ${l.classLabel.toLowerCase()} found.`);
    return;
  }

  // Only sort by JLPT order for language schools
  if (orgType === "language_school") {
    const LEVEL_ORDER = ["N5", "N4", "N3", "N2", "N1"];
    classes.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  }

  let msg = `💰 ${l.feesTitle.mm} / ${l.feesTitle.en}\n📋 ${intake.name}\n\n`;
  for (const c of classes) {
    msg += `${l.levelPrefix}${c.level}: ${formatMMK(c.fee_mmk)}\n`;
  }

  const buttons = getMenuButtons(orgType, customButtons);
  await sendQuickReplies(pageToken, senderPsid, msg.trim(), [
    buttons.find((b) => b.payload === "HOW_TO_ENROLL")!,
    buttons.find((b) => b.payload === "PAYMENT")!,
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ].filter((b): b is { content_type: "text"; title: string; payload: string } => !!b));
}

// ─── 4. Enroll Link ──────────────────────────────────────────────────────────

export async function sendEnrollLink(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { orgType } = await getTenantInfo(tenantId);
  const l = getLabels(orgType);

  const { data: tenant } = await supabase
    .from("tenants")
    .select("subdomain")
    .eq("id", tenantId)
    .single() as { data: { subdomain: string } | null; error: unknown };

  const { data: intake } = await supabase
    .from("intakes")
    .select("name, year, slug")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .order("year", { ascending: false })
    .limit(1)
    .single() as { data: { name: string; year: number; slug: string | null } | null; error: unknown };

  if (!tenant || !intake) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      `${l.enrollEmpty.mm}\n${l.enrollEmpty.en}`,
    );
    return;
  }

  const slug = intakeToSlug(intake.slug, intake.name, intake.year);
  const url = `https://${tenant.subdomain}.kuunyi.com/enroll/${slug}?psid=${senderPsid}`;

  await sendTextMessage(
    pageToken,
    senderPsid,
    `${l.enrollTitle.mm} / ${l.enrollTitle.en}:\n👉 ${url}\n\n` +
      `${l.enrollAction.mm}\n${l.enrollAction.en}`,
  );
}

// ─── 5. Schedule ─────────────────────────────────────────────────────────────

export async function sendSchedule(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { orgType, menuButtons: customButtons } = await getTenantInfo(tenantId);
  const l = getLabels(orgType);

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
      `${l.scheduleEmpty.mm}\n${l.scheduleEmpty.en}`,
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
    const scheduleLabel = orgType === "event" ? "event" : orgType === "training_center" ? "course" : "intake";
    await sendTextMessage(pageToken, senderPsid, `No schedule info for this ${scheduleLabel}.`);
    return;
  }

  // Only sort by JLPT order for language schools
  if (orgType === "language_school") {
    const LEVEL_ORDER = ["N5", "N4", "N3", "N2", "N1"];
    classes.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  }

  let msg = `📅 ${l.scheduleTitle.mm} / ${l.scheduleTitle.en}\n📋 ${intake.name}\n\n`;

  for (const c of classes) {
    msg += `${l.levelPrefix}${c.level}:\n`;
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

  const buttons = getMenuButtons(orgType, customButtons);
  await sendQuickReplies(pageToken, senderPsid, msg.trim(), [
    buttons.find((b) => b.payload === "HOW_TO_ENROLL")!,
    buttons.find((b) => b.payload === "FEES")!,
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ].filter((b): b is { content_type: "text"; title: string; payload: string } => !!b));
}

// ─── 6. Payment Info ─────────────────────────────────────────────────────────

export async function sendPaymentInfo(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { orgType } = await getTenantInfo(tenantId);
  const l = getLabels(orgType);

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
      `ဘဏ်အကောင့် အချက်အလက် မရှိသေးပါ\nNo bank account info available. ${l.contactFallback}`,
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
  const { orgType } = await getTenantInfo(tenantId);
  const l = getLabels(orgType);

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
      `Reference number မတွေ့ပါ / Reference number not found.\n\n"${ref}" ဖြင့် ရှာမတွေ့ပါ။\nNo record found for "${ref}".\n\nPlease check and try again.`,
    );
    return;
  }

  // Check latest payment
  const { data: payment } = (await supabase
    .from("payments")
    .select("status")
    .eq("enrollment_id", enrollment.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()) as { data: Pick<Payment, "status"> | null; error: unknown };

  const orgLabels = STATUS_LABELS[(orgType as OrgType)] ?? STATUS_LABELS.language_school;
  const statusLabel = orgLabels[enrollment.status] ?? {
    en: enrollment.status,
    mm: enrollment.status,
    enPay: payment?.status ?? "Unknown",
    mmPay: payment?.status ?? "Unknown",
  };

  const name = enrollment.student_name_mm
    ? `${enrollment.student_name_en} (${enrollment.student_name_mm})`
    : enrollment.student_name_en;

  if (orgType === "event") {
    // Event / ticket-oriented status message
    let reply =
      `ဝယ်ယူပြီး Ticket Order အခြေအနေကို စစ်ဆေးရန်\n\n`;

    // Myanmar section
    reply += `Ref: ${enrollment.enrollment_ref}\n`;
    reply += `အမည်: ${name}\n\n`;
    reply += `အခြေအနေ: ${statusLabel.mm}\n`;
    reply += `ငွေပေးချေမှု: ${statusLabel.mmPay}\n\n`;

    // English section
    reply += `Check Ticket Status\n\n`;
    reply += `Ref: ${enrollment.enrollment_ref}\n`;
    reply += `Name: ${name}\n\n`;
    reply += `Status: ${statusLabel.en}\n`;
    reply += `Payment: ${statusLabel.enPay}`;

    await sendQuickReplies(pageToken, senderPsid, reply, [
      { content_type: "text", title: "🔄 Check Another", payload: "CHECK_STATUS" },
      { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
    ]);
  } else {
    // Language school / training center status message
    let reply =
      `📋 Enrollment Status / စာရင်းသွင်းမှု အခြေအနေ\n\n` +
      `Ref: ${enrollment.enrollment_ref}\n` +
      `Name / အမည်: ${name}\n`;

    if (enrollment.classes) {
      reply += `${l.statusLevelLabel.en} / ${l.statusLevelLabel.mm}: ${l.levelPrefix}${enrollment.classes.level}\n`;
      reply += `${l.statusFeeLabel.en} / ${l.statusFeeLabel.mm}: ${formatMMK(enrollment.classes.fee_mmk)}\n`;
    }

    reply += `\nStatus: ${statusLabel.en}\nအခြေအနေ: ${statusLabel.mm}`;

    if (payment) {
      reply += `\n\nPayment: ${statusLabel.enPay}\nငွေပေးချေမှု: ${statusLabel.mmPay}`;
    }

    await sendQuickReplies(pageToken, senderPsid, reply, [
      { content_type: "text", title: "🔄 Check Another", payload: "CHECK_STATUS" },
      { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
    ]);
  }
}

// ─── 8. Buy Tickets ──────────────────────────────────────────────────────────

export async function sendBuyTickets(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { orgType, menuButtons: customButtons } = await getTenantInfo(tenantId);

  const { data: tenant } = await supabase
    .from("tenants")
    .select("subdomain")
    .eq("id", tenantId)
    .single() as { data: { subdomain: string } | null; error: unknown };

  const { data: intake } = await supabase
    .from("intakes")
    .select("id, name, year, slug")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .order("year", { ascending: false })
    .limit(1)
    .single() as { data: { id: string; name: string; year: number; slug: string | null } | null; error: unknown };

  if (!tenant || !intake) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      "လောလောဆယ် လက်မှတ်ဝယ်ယူလို့ မရပါသေး\nNo tickets available for purchase currently.",
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

  const slug = intakeToSlug(intake.slug, intake.name, intake.year);
  const url = `https://${tenant.subdomain}.kuunyi.com/enroll/${slug}?psid=${senderPsid}`;

  // Build Myanmar section
  let msg = `Ticket ဝယ်ယူရန်\n\nလက်မှတ်အမျိုးအစားများ\n`;
  if (classes && classes.length > 0) {
    for (const c of classes) {
      msg += `${c.level} – ${formatMMK(c.fee_mmk)}\n`;
    }
  }
  msg += `ဝယ်ယူလိုသော Ticket အမျိုးအစားကို ရွေးချယ်ပြီး ဆက်လက်လုပ်ဆောင်နိုင်ပါသည်။\n\n`;
  msg += `👉 ${url}\n\n`;
  msg += `အထက်ပါ link ကိုနှိပ်ပြီး လိုအပ်သော အချက်အလက်များကို ဖြည့်စွက်၍ Ticket ဝယ်ယူနိုင်ပါသည်။\n\n`;

  // Build English section
  msg += `Buy Tickets\n\nTicket Types:\n`;
  if (classes && classes.length > 0) {
    for (const c of classes) {
      msg += `${c.level} – ${formatMMK(c.fee_mmk)}\n`;
    }
  }
  msg += `Please select your preferred ticket type to continue.\n\n`;
  msg += `👉 ${url}\n\n`;
  msg += `Click the link above and fill in the required information to purchase your ticket.`;

  const buttons = getMenuButtons(orgType, customButtons);
  await sendQuickReplies(pageToken, senderPsid, msg, [
    buttons.find((b) => b.payload === "EVENTS")!,
    buttons.find((b) => b.payload === "PAYMENT")!,
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ].filter((b): b is { content_type: "text"; title: string; payload: string } => !!b));
}

// ─── 9. Events ───────────────────────────────────────────────────────────────

export async function sendEvents(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const { orgType, menuButtons: customButtons } = await getTenantInfo(tenantId);

  const msg =
    `ပွဲအစီစဉ် \n\n` +
    `ပွဲကျင်းပမည့်ရက် – ၂၀၂၆ ခုနှစ် ဧပြီလ ၁၃ ရက် မှ ၁၆ ရက်အထိ\n` +
    `နေရာ – Golden Inya Island, Yangon\n\n` +
    `Events\n\n` +
    `Event Dates – April 13 – April 16, 2026\n` +
    `Location – Golden Inya Island, Yangon`;

  const buttons = getMenuButtons(orgType, customButtons);
  await sendQuickReplies(pageToken, senderPsid, msg, [
    buttons.find((b) => b.payload === "HOW_TO_ENROLL")!,
    buttons.find((b) => b.payload === "FEES")!,
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ].filter((b): b is { content_type: "text"; title: string; payload: string } => !!b));
}

// ─── 9. Live Agent Handoff ─────────────────────────────────────────────────

export async function sendHandoffStart(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  // Fetch timeout setting
  const { data: tenant } = await supabase
    .from("tenants")
    .select("handoff_timeout_min")
    .eq("id", tenantId)
    .single() as { data: { handoff_timeout_min: number } | null; error: unknown };

  const timeoutMin = tenant?.handoff_timeout_min ?? 15;
  const expiresAt = new Date(Date.now() + timeoutMin * 60 * 1000).toISOString();

  // Upsert handoff session
  await supabase
    .from("messenger_handoffs")
    .upsert(
      { tenant_id: tenantId, sender_psid: senderPsid, expires_at: expiresAt } as never,
      { onConflict: "tenant_id,sender_psid" },
    );

  await sendTextMessage(
    pageToken,
    senderPsid,
    `Live Agent / Admin နှင့်တိုက်ရိုက်ပြောရန်\n\n` +
      `Admin နှင့် တိုက်ရိုက် စကားပြောနိုင်ရန် ချိတ်ဆက်ပေးနေပါသည်။ ခဏလေး စောင့်ပေးပါ\n` +
      `Bot ကို ပြန်အသုံးပြုလိုပါက "bot" ဟု ရိုက်ပါ။\n\n` +
      `Live Agent\n\n` +
      `Connecting you to an Admin. Please wait\n` +
      `Type "bot" anytime to return to the bot`,
  );
}

// ─── 9. Unrecognized Input ──────────────────────────────────────────────────

export async function sendUnrecognized(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const { orgType, menuButtons: customButtons } = await getTenantInfo(tenantId);

  await sendQuickReplies(
    pageToken,
    senderPsid,
    `အသေးစိတ်လေးကို Admin မှပြန်လည်ဖြေကြားပေးပါမည်။ Admin နဲ့တိုက်ရိုက်ဆက်သွယ်ရန် Live Agent ဟုရိုက်ပါ။\n\n` +
      `Admin team will get back to you with more details.\nType "Live Agent" to talk directly with Admin.`,
    getMenuButtons(orgType, customButtons),
  );
}

// ─── 10. Handoff Check ──────────────────────────────────────────────────────

export async function checkHandoff(
  tenantId: string,
  senderPsid: string,
): Promise<boolean> {
  const supabase = createAdminClient();

  const { data } = await supabase
    .from("messenger_handoffs")
    .select("expires_at")
    .eq("tenant_id", tenantId)
    .eq("sender_psid", senderPsid)
    .single() as { data: { expires_at: string } | null; error: unknown };

  if (!data) return false;

  // Check if expired
  if (new Date(data.expires_at) < new Date()) {
    // Clean up expired session
    await supabase
      .from("messenger_handoffs")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("sender_psid", senderPsid);
    return false;
  }

  return true;
}

// ─── 11. End Handoff ────────────────────────────────────────────────────────

export async function endHandoff(
  tenantId: string,
  senderPsid: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  await supabase
    .from("messenger_handoffs")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("sender_psid", senderPsid);

  await sendWelcome(tenantId, senderPsid, pageToken);
}
