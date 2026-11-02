import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Where the public routes read the Telegram bot username ─────────────────
//
// Migration 071 moved bot_username from tenant_telegram_configs to tenant_bots.
// The routes kept selecting the old column, got a 400 they ignored, and reported
// no bot, so the Connect Telegram button never showed. The mock answers the way
// PostgREST does: a column the schema does not have is an error, not a null.

type Row = Record<string, unknown>;

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn(async () => "ten-1") }));

const COLUMNS: Record<string, string[] | undefined> = {
  tenant_telegram_configs: ["tenant_id", "allowed_chat_ids", "enabled", "enable_join_requests", "enable_phone_flow"],
  tenant_bots: ["tenant_id", "bot_type", "bot_token", "bot_username", "webhook_secret", "enabled"],
};

let tables: Record<string, Row[]>;
let readFails: string | null;

function chainFor(table: string) {
  let columns: string[] = [];
  const filters: [string, unknown][] = [];

  const read = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
    if (table === readFails) return { data: null, error: { message: "connection lost" } };
    const missing = columns.find((c) => COLUMNS[table] && !COLUMNS[table]!.includes(c));
    if (missing) return { data: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } };
    return { data: (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)), error: null };
  };

  const chain: Record<string, unknown> = {
    select: (cols: string) => {
      columns = cols.split(",").map((c) => c.trim());
      return chain;
    },
    eq: (key: string, value: unknown) => {
      filters.push([key, value]);
      return chain;
    },
    update: () => chain,
    order: () => chain,
    limit: () => chain,
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
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(read()).then(resolve),
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: chainFor }),
}));

const enrollmentBot = { tenant_id: "ten-1", bot_type: "enrollment", bot_username: "school_bot", enabled: true };
const supportBot = { tenant_id: "ten-1", bot_type: "support", bot_username: "helpdesk_bot", enabled: true };

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  readFails = null;
  tables = {
    enrollments: [{
      id: "enr-1",
      tenant_id: "ten-1",
      enrollment_ref: "R",
      status: "payment_submitted",
      class_id: "cls-1",
      quantity: 1,
      student_name_en: "Mg Mg",
      telegram_chat_id: null,
      classes: { id: "cls-1", level: "N5", fee_amount: 1000, image_url: null, pack_size: 1, intakes: null },
    }],
    tenants: [{ id: "ten-1", org_type: "language_school", currency: "MMK" }],
    tenant_telegram_configs: [{ tenant_id: "ten-1", enabled: true }],
    tenant_bots: [],
  };
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

async function statusBotUsername() {
  const { GET } = await import("@/app/api/public/status/route");
  const res = await GET(new NextRequest("https://t.kuunyi.com/api/public/status?ref=R"));
  expect(res.status).toBe(200);
  return (await res.json()).telegram_bot_username;
}

async function requestLinkToken() {
  const { POST } = await import("@/app/api/public/telegram-link-token/route");
  return POST(new NextRequest("https://t.kuunyi.com/api/public/telegram-link-token", {
    method: "POST",
    body: JSON.stringify({ enrollment_ref: "R" }),
  }));
}

describe("GET /api/public/status telegram_bot_username", () => {
  it("reports the tenant's enabled enrollment bot", async () => {
    tables.tenant_bots = [supportBot, enrollmentBot];
    expect(await statusBotUsername()).toBe("school_bot");
  });

  it("follows the bot's own switch, not the config row's", async () => {
    tables.tenant_telegram_configs = [{ tenant_id: "ten-1", enabled: false }];
    tables.tenant_bots = [enrollmentBot];
    expect(await statusBotUsername()).toBe("school_bot");

    tables.tenant_telegram_configs = [{ tenant_id: "ten-1", enabled: true }];
    tables.tenant_bots = [{ ...enrollmentBot, enabled: false }];
    expect(await statusBotUsername()).toBeNull();
  });

  it("does not offer a support bot to buyers", async () => {
    tables.tenant_bots = [supportBot];
    expect(await statusBotUsername()).toBeNull();
  });

  it("treats a tenant with no bot as normal, not as a failed read", async () => {
    expect(await statusBotUsername()).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("still answers when the read fails, and says so in the log", async () => {
    tables.tenant_bots = [enrollmentBot];
    readFails = "tenant_bots";
    expect(await statusBotUsername()).toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("POST /api/public/telegram-link-token", () => {
  it("links to the tenant's enabled enrollment bot", async () => {
    tables.tenant_bots = [supportBot, enrollmentBot];
    const res = await requestLinkToken();
    expect(res.status).toBe(200);
    expect((await res.json()).deepLink).toMatch(/^https:\/\/t\.me\/school_bot\?start=/);
  });

  it.each([
    ["no bot", () => []],
    ["only a support bot", () => [supportBot]],
    ["a disabled enrollment bot", () => [{ ...enrollmentBot, enabled: false }]],
  ])("refuses a tenant with %s", async (_label, bots) => {
    tables.tenant_bots = bots();
    expect((await requestLinkToken()).status).toBe(400);
  });

  it("logs a failed read rather than passing it off as not configured", async () => {
    tables.tenant_bots = [enrollmentBot];
    readFails = "tenant_bots";
    expect((await requestLinkToken()).status).toBe(400);
    expect(consoleError).toHaveBeenCalled();
  });
});
