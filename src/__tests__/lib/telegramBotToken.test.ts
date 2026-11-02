import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Where the Telegram senders read the bot token ──────────────────────────
//
// Migration 071 moved bot_token from tenant_telegram_configs to tenant_bots, and
// 068 dropped tenants.telegram_bot_token. These readers kept selecting the old
// columns, got an error they ignored, and sent nothing. The mock answers the way
// PostgREST does: a column the schema does not have is an error, not a null.
//
// The crypto is real on purpose. tenant_bots holds two formats: rows carried over
// by 071 were written with the Messenger helper, later ones with the Telegram one.

type Row = Record<string, unknown>;

const ENROLLMENT_TOKEN = "111:enrollment-token";
const SUPPORT_TOKEN = "222:support-token";

vi.mock("@/lib/api", async () => {
  const { NextResponse } = await import("next/server");
  const auth = async () => ({ tenantId: "ten-1" });
  return {
    requireAuth: auth,
    requireOwner: auth,
    badRequest: (message: string) => NextResponse.json({ error: message }, { status: 400 }),
    notFound: (what: string) => NextResponse.json({ error: `${what} not found` }, { status: 404 }),
  };
});

const COLUMNS: Record<string, string[] | undefined> = {
  tenant_telegram_configs: ["tenant_id", "allowed_chat_ids", "enabled", "enable_join_requests", "enable_phone_flow"],
  tenant_bots: ["tenant_id", "bot_type", "bot_token", "bot_username", "webhook_secret", "enabled"],
  tenants: ["id", "org_type", "telegram_auto_send_invite"],
};

let tables: Record<string, Row[]>;
let readFails: string | null;
let writes: { table: string; op: string; values?: Row }[];

function chainFor(table: string) {
  let columns: string[] = [];
  let write: { op: string; values?: Row } | null = null;
  const filters: ((r: Row) => boolean)[] = [];

  const read = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
    if (table === readFails) return { data: null, error: { message: "connection lost" } };
    const missing = columns.find((c) => c !== "*" && COLUMNS[table] && !COLUMNS[table]!.includes(c));
    if (missing) return { data: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } };
    return { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
  };

  const chain: Record<string, unknown> = {
    select: (cols: string) => {
      columns = cols.split(",").map((c) => c.trim());
      return chain;
    },
    eq: (key: string, value: unknown) => {
      filters.push((r) => r[key] === value);
      return chain;
    },
    is: (key: string, value: unknown) => {
      filters.push((r) => (r[key] ?? null) === value);
      return chain;
    },
    not: (key: string) => {
      filters.push((r) => r[key] != null);
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    update: (values: Row) => {
      write = { op: "update", values };
      writes.push({ table, ...write });
      return chain;
    },
    delete: () => {
      write = { op: "delete" };
      writes.push({ table, ...write });
      return chain;
    },
    insert: (values: Row) => {
      write = { op: "insert", values };
      writes.push({ table, ...write });
      return {
        select: () => ({ single: async () => ({ data: { id: "new", ...values }, error: null }) }),
      };
    },
    // PostgREST reports zero rows to .single() as an error, and to .maybeSingle() as null.
    single: async () => {
      const { data, error } = read();
      if (error) return { data: null, error };
      if (data!.length === 0) return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { data: data![0], error: null };
    },
    maybeSingle: async () => {
      const { data, error } = read();
      return { data: data?.[0] ?? null, error };
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(write ? { data: null, error: null } : read()).then(resolve),
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: chainFor }),
}));

// ─── Telegram API stand-in ──────────────────────────────────────────────────

let telegramCalls: { token: string; method: string; body: Row }[];

function stubTelegram() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const match = /\/bot(.+)\/(\w+)$/.exec(url);
    if (!match) throw new Error(`unexpected fetch: ${url}`);
    const [, token, method] = match;
    telegramCalls.push({ token, method, body: JSON.parse(String(init?.body ?? "{}")) });

    const results: Record<string, unknown> = {
      getMe: { id: 7, username: "school_bot" },
      getChatMember: { status: "administrator" },
      getChat: { id: -100, title: "N5 Channel", type: "channel" },
      getChatMemberCount: 42,
      createChatInviteLink: { invite_link: "https://t.me/+invite" },
    };
    return new Response(JSON.stringify({ ok: true, result: results[method] ?? true }), { status: 200 });
  }));
}

const sends = () => telegramCalls.filter((c) => c.method === "sendMessage");

// ─── Fixtures ───────────────────────────────────────────────────────────────

let currentFormat: (plain: string) => string;
let legacyFormat: (plain: string) => string;

const enrollmentBot = (extra: Row = {}) => ({
  tenant_id: "ten-1",
  bot_type: "enrollment",
  bot_token: currentFormat(ENROLLMENT_TOKEN),
  enabled: true,
  ...extra,
});
const supportBot = () => ({
  tenant_id: "ten-1",
  bot_type: "support",
  bot_token: currentFormat(SUPPORT_TOKEN),
  enabled: true,
});

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  process.env.TELEGRAM_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.MESSENGER_ENCRYPTION_KEY = "cd".repeat(32);
  currentFormat = (await import("@/lib/telegram/crypto")).encryptToken;
  legacyFormat = (await import("@/lib/messenger/crypto")).encryptToken;

  readFails = null;
  writes = [];
  telegramCalls = [];
  tables = {
    tenants: [{ id: "ten-1", org_type: "language_school", telegram_auto_send_invite: true }],
    tenant_telegram_configs: [{ tenant_id: "ten-1", enabled: true }],
    tenant_bots: [supportBot(), enrollmentBot()],
    class_channels: [{
      id: "ch-1",
      tenant_id: "ten-1",
      class_id: "cls-1",
      intake_id: "int-1",
      telegram_channel_id: "-100",
      telegram_channel_name: "N5 Channel",
      telegram_invite_link: "https://t.me/+invite",
    }],
    enrollments: [
      { id: "enr-1", tenant_id: "ten-1", class_id: "cls-1", intake_id: "int-1", telegram_chat_id: "501" },
      { id: "enr-2", tenant_id: "ten-1", class_id: "cls-1", intake_id: "int-1", telegram_chat_id: "501" },
      { id: "enr-3", tenant_id: "ten-1", class_id: "cls-1", intake_id: "int-1", telegram_chat_id: "502" },
      { id: "enr-4", tenant_id: "ten-1", class_id: "cls-1", intake_id: "int-1", telegram_chat_id: null },
      { id: "enr-5", tenant_id: "ten-1", class_id: "cls-1", intake_id: "int-1", telegram_chat_id: "503", internal_test_at: "2026-11-01" },
    ],
    announcements: [{
      id: "ann-1",
      tenant_id: "ten-1",
      intake_id: "int-1",
      class_level: null,
      target_label: "All Classes",
      message: "Class moved",
      dispatched_at: null,
    }],
  };
  stubTelegram();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

// ─── Callers ────────────────────────────────────────────────────────────────

async function notifyApproved() {
  const { sendTelegramStatusNotification } = await import("@/lib/telegram/notify");
  return sendTelegramStatusNotification({
    tenantId: "ten-1",
    telegramChatId: "501",
    action: "approve",
    studentName: "Mg Mg",
    enrollmentRef: "R",
    classLevel: "N5",
    statusUrl: "https://t.kuunyi.com/status?ref=R",
    paymentUrl: "https://t.kuunyi.com/status?ref=R",
  });
}

async function sendInvite() {
  const { sendChannelInviteIfEligible } = await import("@/lib/telegram/channel-invite");
  return sendChannelInviteIfEligible({
    tenantId: "ten-1",
    enrollmentId: "enr-1",
    classId: "cls-1",
    telegramChatId: "501",
    studentName: "Mg Mg",
  });
}

async function linkChannel() {
  const { POST } = await import("@/app/api/admin/channels/route");
  return POST(new NextRequest("https://t.kuunyi.com/api/admin/channels", {
    method: "POST",
    body: JSON.stringify({ class_id: "cls-2", intake_id: "int-1", telegram_channel_id: "-100" }),
  }));
}

async function channelDetails() {
  const { GET } = await import("@/app/api/admin/channels/[id]/route");
  const res = await GET(new NextRequest("https://t.kuunyi.com/api/admin/channels/ch-1"), {
    params: Promise.resolve({ id: "ch-1" }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function dispatchAnnouncement() {
  const { POST } = await import("@/app/api/admin/announcements/[id]/dispatch/route");
  return POST(new NextRequest("https://t.kuunyi.com/api/admin/announcements/ann-1/dispatch", { method: "POST" }), {
    params: Promise.resolve({ id: "ann-1" }),
  });
}

async function unlinkTelegram() {
  const { DELETE } = await import("@/app/api/admin/enrollments/[id]/telegram/route");
  const res = await DELETE(new NextRequest("https://t.kuunyi.com/api/admin/enrollments/enr-1/telegram"), {
    params: Promise.resolve({ id: "enr-1" }),
  });
  expect(res.status).toBe(200);
}

const dispatchRecorded = () =>
  writes.some((w) => w.table === "announcements" && w.op === "update" && w.values?.dispatched_at);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("sendTelegramStatusNotification", () => {
  it("sends through the enrollment bot, not the support bot", async () => {
    expect(await notifyApproved()).toBe(true);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].token).toBe(ENROLLMENT_TOKEN);
    expect(sends()[0].body.chat_id).toBe("501");
  });

  it("reads a token carried over from before tenant_bots", async () => {
    tables.tenant_bots = [enrollmentBot({ bot_token: legacyFormat(ENROLLMENT_TOKEN) })];
    expect(await notifyApproved()).toBe(true);
    expect(sends()[0].token).toBe(ENROLLMENT_TOKEN);
  });

  it("follows the bot's own switch, not the config row's", async () => {
    tables.tenant_telegram_configs = [{ tenant_id: "ten-1", enabled: false }];
    expect(await notifyApproved()).toBe(true);

    telegramCalls = [];
    tables.tenant_telegram_configs = [{ tenant_id: "ten-1", enabled: true }];
    tables.tenant_bots = [enrollmentBot({ enabled: false })];
    expect(await notifyApproved()).toBe(false);
    expect(telegramCalls).toHaveLength(0);
  });

  it("never falls back to a support bot", async () => {
    tables.tenant_bots = [supportBot()];
    expect(await notifyApproved()).toBe(false);
    expect(telegramCalls).toHaveLength(0);
  });

  it("treats a tenant with no bot as normal, not as a failed read", async () => {
    tables.tenant_bots = [];
    expect(await notifyApproved()).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs a failed read", async () => {
    readFails = "tenant_bots";
    expect(await notifyApproved()).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    expect(telegramCalls).toHaveLength(0);
  });

  it("logs a token it cannot decrypt, without printing the token", async () => {
    const stored = "not-a-real-ciphertext";
    tables.tenant_bots = [enrollmentBot({ bot_token: stored })];
    expect(await notifyApproved()).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(stored);
    expect(telegramCalls).toHaveLength(0);
  });
});

describe("sendChannelInviteIfEligible", () => {
  it("sends the invite through the enrollment bot", async () => {
    expect(await sendInvite()).toBe(true);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].token).toBe(ENROLLMENT_TOKEN);
    expect(JSON.stringify(sends()[0].body)).toContain("https://t.me/+invite");
  });

  it.each([
    ["an event tenant", () => { tables.tenants[0].org_type = "event"; }],
    ["auto-send switched off", () => { tables.tenants[0].telegram_auto_send_invite = false; }],
    ["a disabled enrollment bot", () => { tables.tenant_bots = [enrollmentBot({ enabled: false })]; }],
    ["only a support bot", () => { tables.tenant_bots = [supportBot()]; }],
    ["no channel for the class", () => { tables.class_channels = []; }],
  ])("skips %s", async (_label, arrange) => {
    arrange();
    expect(await sendInvite()).toBe(false);
    expect(sends()).toHaveLength(0);
  });
});

describe("POST /api/admin/channels", () => {
  it("links a channel using the enrollment bot", async () => {
    const res = await linkChannel();
    expect(res.status).toBe(201);
    expect(telegramCalls.length).toBeGreaterThan(0);
    expect(telegramCalls.every((c) => c.token === ENROLLMENT_TOKEN)).toBe(true);
    expect(writes.some((w) => w.table === "class_channels" && w.op === "insert")).toBe(true);
  });

  it("refuses when the enrollment bot is disabled", async () => {
    tables.tenant_bots = [supportBot(), enrollmentBot({ enabled: false })];
    expect((await linkChannel()).status).toBe(400);
    expect(telegramCalls).toHaveLength(0);
  });

  it("does not report a failed read as a bot that is not connected", async () => {
    readFails = "tenant_bots";
    expect((await linkChannel()).status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("GET /api/admin/channels/[id]", () => {
  it("reports the member count using the enrollment bot", async () => {
    const body = await channelDetails();
    expect(body.memberCount).toBe(42);
    expect(telegramCalls.map((c) => c.token)).toEqual([ENROLLMENT_TOKEN]);
  });

  it("does not use a disabled bot", async () => {
    tables.tenant_bots = [enrollmentBot({ enabled: false })];
    expect((await channelDetails()).memberCount).toBeNull();
    expect(telegramCalls).toHaveLength(0);
  });
});

describe("POST /api/admin/announcements/[id]/dispatch", () => {
  it("sends once per chat through the enrollment bot, and records it", async () => {
    const res = await dispatchAnnouncement();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, failed: 0 });
    expect(sends().map((c) => c.body.chat_id).sort()).toEqual(["501", "502"]);
    expect(sends().every((c) => c.token === ENROLLMENT_TOKEN)).toBe(true);
    expect(dispatchRecorded()).toBe(true);
  });

  it("refuses an announcement already dispatched", async () => {
    tables.announcements[0].dispatched_at = "2026-11-01";
    expect((await dispatchAnnouncement()).status).toBe(409);
    expect(telegramCalls).toHaveLength(0);
  });

  it("refuses a disabled bot and leaves the announcement unsent", async () => {
    tables.tenant_bots = [supportBot(), enrollmentBot({ enabled: false })];
    expect((await dispatchAnnouncement()).status).toBe(400);
    expect(telegramCalls).toHaveLength(0);
    expect(dispatchRecorded()).toBe(false);
  });

  it("leaves the announcement unsent when the token cannot be decrypted", async () => {
    tables.tenant_bots = [enrollmentBot({ bot_token: "not-a-real-ciphertext" })];
    expect((await dispatchAnnouncement()).status).toBe(500);
    expect(dispatchRecorded()).toBe(false);
  });
});

describe("DELETE /api/admin/enrollments/[id]/telegram", () => {
  it("removes the student from the class channel using the enrollment bot", async () => {
    await unlinkTelegram();
    expect(telegramCalls.map((c) => [c.method, c.token])).toEqual([
      ["banChatMember", ENROLLMENT_TOKEN],
      ["unbanChatMember", ENROLLMENT_TOKEN],
    ]);
    expect(telegramCalls[0].body).toMatchObject({ chat_id: "-100", user_id: 501 });
  });

  it("still clears the link when the bot is disabled, without calling Telegram", async () => {
    tables.tenant_bots = [enrollmentBot({ enabled: false })];
    await unlinkTelegram();
    expect(telegramCalls).toHaveLength(0);
    expect(writes.some((w) => w.table === "enrollments" && w.values?.telegram_chat_id === null)).toBe(true);
  });

  it("still clears the link when the read fails, and says so in the log", async () => {
    readFails = "tenant_bots";
    await unlinkTelegram();
    expect(consoleError).toHaveBeenCalled();
    expect(writes.some((w) => w.table === "enrollments" && w.values?.telegram_chat_id === null)).toBe(true);
  });
});
