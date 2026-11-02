import { readFileSync } from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Telegram announcements ─────────────────────────────────────────────────
//
// The mock answers the way PostgREST does: a column the table does not have is an
// error, not a null, and a read returns at most 1000 rows. enrollments has neither
// intake_id nor class_level, and a mock that allowed them hid for months that this
// query had never worked.

type Row = Record<string, unknown>;

const BOT_TOKEN = "111:enrollment-token";
const MAX_ROWS = 1000;

const COLUMNS: Record<string, string[] | undefined> = {
  enrollments: ["id", "tenant_id", "class_id", "status", "telegram_chat_id", "internal_test_at"],
  classes: ["id", "tenant_id", "intake_id", "level"],
  tenant_bots: ["tenant_id", "bot_type", "bot_token", "bot_username", "webhook_secret", "enabled"],
  tenants: ["id", "telegram_auto_send_invite"],
};

let role: string;
let tables: Record<string, Row[]>;
let readFails: string | null;
let claimFails: boolean;
let losesClaimRace: boolean;

function chainFor(table: string) {
  let columns: string[] = [];
  let embedsItems = false;
  let update: Row | null = null;
  let returning = false;
  let range: [number, number] | null = null;
  let badColumn: string | null = null;
  const filters: ((r: Row) => boolean)[] = [];

  const checkColumn = (key: string) => {
    if (key !== "*" && COLUMNS[table] && !COLUMNS[table]!.includes(key)) badColumn = key;
  };

  const read = () => {
    if (table === readFails) return { data: null, error: { message: "connection lost" } };
    if (badColumn) return { data: null, error: { code: "42703", message: `column ${table}.${badColumn} does not exist` } };
    let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (embedsItems) rows = rows.filter((r) => ((r.items as unknown[]) ?? []).length > 0);
    const [from, to] = range ?? [0, Infinity];
    return { data: rows.slice(from, to + 1).slice(0, MAX_ROWS), error: null };
  };

  const applyUpdate = () => {
    if (table === "announcements" && update && "dispatched_at" in update) {
      if (claimFails) return { data: null, error: { message: "connection lost" } };
      if (losesClaimRace) return { data: [], error: null };
    }
    if (badColumn) return { data: null, error: { code: "42703", message: `column ${table}.${badColumn} does not exist` } };
    const matched = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    for (const row of matched) Object.assign(row, update);
    return { data: returning ? matched.map((r) => ({ ...r })) : null, error: null };
  };

  const chain: Record<string, unknown> = {
    select: (cols: string) => {
      if (update) {
        returning = true;
        return chain;
      }
      embedsItems = cols.includes("enrollment_items!inner(");
      columns = cols.replace(/,?\s*enrollment_items!inner\([^)]*\)/, "").split(",").map((c) => c.trim());
      columns.forEach(checkColumn);
      return chain;
    },
    eq: (key: string, value: unknown) => {
      checkColumn(key);
      filters.push((r) => r[key] === value);
      return chain;
    },
    is: (key: string, value: unknown) => {
      checkColumn(key);
      filters.push((r) => (r[key] ?? null) === value);
      return chain;
    },
    not: (key: string) => {
      checkColumn(key);
      filters.push((r) => r[key] != null);
      return chain;
    },
    in: (key: string, values: unknown[]) => {
      if (key === "enrollment_items.class_id") {
        filters.push((r) => ((r.items as unknown[]) ?? []).some((c) => values.includes(c)));
      } else {
        checkColumn(key);
        filters.push((r) => values.includes(r[key]));
      }
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    range: (from: number, to: number) => {
      range = [from, to];
      return chain;
    },
    update: (values: Row) => {
      Object.keys(values).forEach((k) => {
        if (table !== "announcements") checkColumn(k);
      });
      update = values;
      return chain;
    },
    single: async () => {
      const { data, error } = read();
      if (error) return { data: null, error };
      if (data!.length === 0) return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { data: { ...data![0] }, error: null };
    },
    maybeSingle: async () => {
      const { data, error } = read();
      return { data: data?.[0] ?? null, error };
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(update ? applyUpdate() : read()).then(resolve),
  };
  return chain;
}

const client = { from: chainFor };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => client }));

vi.mock("@/lib/api", async () => {
  const { NextResponse } = await import("next/server");
  const ctx = () => ({ tenantId: "ten-1", supabase: client, user: { id: "u-1", role, email: "a@b.c" } });
  return {
    requireAuth: async () => ctx(),
    requireOwner: async () =>
      role === "owner"
        ? ctx()
        : NextResponse.json({ error: "Forbidden", message: "Owner access required." }, { status: 403 }),
    badRequest: (message: string) => NextResponse.json({ error: "Bad Request", message }, { status: 400 }),
  };
});

// ─── Telegram API stand-in ──────────────────────────────────────────────────

let sends: { at: number; chatId: string; text: string; parseMode: string; signal: unknown }[];
let respond: (chatId: string, attempt: number) => Response | Promise<Response>;

const ok = () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
const rateLimited = (retryAfter: number) =>
  new Response(
    JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: retryAfter } }),
    { status: 429 },
  );

function stubTelegram() {
  respond = () => ok();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes(`/bot${BOT_TOKEN}/sendMessage`)) throw new Error(`unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body));
    const chatId = String(body.chat_id);
    sends.push({ at: Date.now(), chatId, text: body.text, parseMode: body.parse_mode, signal: init?.signal });
    return respond(chatId, sends.filter((s) => s.chatId === chatId).length);
  }));
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const enrollment = (chatId: string | null, extra: Row = {}): Row => ({
  id: `enr-${Math.random()}`,
  tenant_id: "ten-1",
  class_id: "cls-n5",
  status: "confirmed",
  telegram_chat_id: chatId,
  internal_test_at: null,
  items: [],
  ...extra,
});

const manyEnrollments = (n: number) =>
  Array.from({ length: n }, (_, i) => enrollment(String(1000 + i)));

const sentTo = () => sends.map((s) => s.chatId).sort();
const announcement = () => tables.announcements[0];

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  process.env.TELEGRAM_ENCRYPTION_KEY = "ab".repeat(32);
  const { encryptToken } = await import("@/lib/telegram/crypto");

  role = "owner";
  readFails = null;
  claimFails = false;
  losesClaimRace = false;
  sends = [];
  tables = {
    tenants: [{ id: "ten-1", telegram_auto_send_invite: false }],
    tenant_bots: [{
      tenant_id: "ten-1",
      bot_type: "enrollment",
      bot_token: encryptToken(BOT_TOKEN),
      bot_username: "school_bot",
      webhook_secret: "s",
      enabled: true,
    }],
    classes: [
      { id: "cls-n5", tenant_id: "ten-1", intake_id: "int-1", level: "N5" },
      { id: "cls-n4", tenant_id: "ten-1", intake_id: "int-1", level: "N4" },
      { id: "cls-other", tenant_id: "ten-1", intake_id: "int-2", level: "N5" },
    ],
    enrollments: [enrollment("501"), enrollment("502")],
    announcements: [{
      id: "ann-1",
      tenant_id: "ten-1",
      intake_id: "int-1",
      class_level: null,
      target_label: "All Classes",
      message: "Class moved",
      dispatched_at: null,
      dispatch_completed_at: null,
      telegram_recipient_count: 0,
      telegram_sent_count: 0,
      telegram_failed_count: 0,
    }],
  };
  stubTelegram();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── Callers ────────────────────────────────────────────────────────────────

async function dispatch() {
  const { POST } = await import("@/app/api/admin/announcements/[id]/dispatch/route");
  return POST(new NextRequest("https://t.kuunyi.com/api/admin/announcements/ann-1/dispatch", { method: "POST" }), {
    params: Promise.resolve({ id: "ann-1" }),
  });
}

async function recipientCount(query = "intake_id=int-1") {
  const { GET } = await import("@/app/api/admin/announcements/recipients/route");
  const res = await GET(new NextRequest(`https://t.kuunyi.com/api/admin/announcements/recipients?${query}`));
  return { status: res.status, body: await res.json() };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("who receives an announcement", () => {
  it("reaches buyers in the intake through the classes table", async () => {
    const res = await dispatch();
    expect(res.status).toBe(200);
    expect(sentTo()).toEqual(["501", "502"]);
    expect(sends.every((s) => s.parseMode === "HTML")).toBe(true);
  });

  it("reaches cart orders, whose classes are on enrollment_items", async () => {
    tables.enrollments = [enrollment("601", { class_id: null, items: ["cls-n5"] })];
    await dispatch();
    expect(sentTo()).toEqual(["601"]);
  });

  it("sends once to a chat with both a direct and a cart enrollment", async () => {
    tables.enrollments = [enrollment("701"), enrollment("701", { class_id: null, items: ["cls-n4"] })];
    await dispatch();
    expect(sentTo()).toEqual(["701"]);
  });

  it("targets only the announcement's class level", async () => {
    announcement().class_level = "N4";
    tables.enrollments = [
      enrollment("801"),
      enrollment("802", { class_id: "cls-n4" }),
      enrollment("803", { class_id: null, items: ["cls-n5"] }),
      enrollment("804", { class_id: null, items: ["cls-n4"] }),
    ];
    await dispatch();
    expect(sentTo()).toEqual(["802", "804"]);
  });

  it("leaves out other intakes, other tenants, unlinked and internal test orders", async () => {
    tables.enrollments = [
      enrollment("901", { class_id: "cls-other" }),
      enrollment("902", { tenant_id: "ten-2" }),
      enrollment(null),
      enrollment("904", { internal_test_at: "2026-11-01" }),
      enrollment("905"),
    ];
    await dispatch();
    expect(sentTo()).toEqual(["905"]);
  });

  it("sends only to confirmed, partial and submitted payments", async () => {
    tables.enrollments = [
      enrollment("1", { status: "confirmed" }),
      enrollment("2", { status: "partial_payment" }),
      enrollment("3", { status: "payment_submitted" }),
      enrollment("4", { status: "pending_payment" }),
      enrollment("5", { status: "rejected" }),
    ];
    await dispatch();
    expect(sentTo()).toEqual(["1", "2", "3"]);
  });

  it("still reaches a chat with one rejected and one confirmed enrollment", async () => {
    tables.enrollments = [enrollment("6", { status: "rejected" }), enrollment("6", { status: "confirmed" })];
    await dispatch();
    expect(sentTo()).toEqual(["6"]);
  });

  it("refuses when the intake is gone, rather than messaging the whole tenant", async () => {
    announcement().intake_id = null;
    const res = await dispatch();
    expect(res.status).toBe(400);
    expect(sends).toHaveLength(0);
    expect(announcement().dispatched_at).toBeNull();
  });
});

describe("GET /api/admin/announcements/recipients", () => {
  it("counts exactly who a send reaches", async () => {
    tables.enrollments = [
      enrollment("1", { status: "confirmed" }),
      enrollment("1", { status: "payment_submitted" }),
      enrollment("2", { status: "partial_payment" }),
      enrollment("3", { status: "rejected" }),
      enrollment("4", { status: "pending_payment" }),
      enrollment("5", { class_id: null, items: ["cls-n4"] }),
      enrollment("6", { class_id: "cls-other" }),
    ];
    const { body } = await recipientCount();
    await dispatch();
    expect(body.count).toBe(3);
    expect(sends).toHaveLength(body.count);
  });

  it("filters by class level", async () => {
    tables.enrollments = [enrollment("1"), enrollment("2", { class_id: "cls-n4" })];
    expect((await recipientCount("intake_id=int-1&class_level=N4")).body.count).toBe(1);
  });

  it("counts past the 1000 rows one read returns", async () => {
    tables.enrollments = manyEnrollments(1200);
    expect((await recipientCount()).body.count).toBe(1200);
  });

  it("reports a failed read instead of a count of zero", async () => {
    readFails = "enrollments";
    expect((await recipientCount()).status).toBe(500);
  });
});

describe("only one request can send", () => {
  it("sends once when two requests arrive together", async () => {
    const [a, b] = await Promise.all([dispatch(), dispatch()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(sentTo()).toEqual(["501", "502"]);
  });

  it("refuses an announcement already claimed", async () => {
    announcement().dispatched_at = "2026-11-01T00:00:00Z";
    expect((await dispatch()).status).toBe(409);
    expect(sends).toHaveLength(0);
  });

  it("sends nothing when another request wins between the read and the claim", async () => {
    losesClaimRace = true;
    expect((await dispatch()).status).toBe(409);
    expect(sends).toHaveLength(0);
  });

  it("sends nothing when the claim cannot be written", async () => {
    claimFails = true;
    expect((await dispatch()).status).toBe(500);
    expect(sends).toHaveLength(0);
  });

  it("stays sendable when the recipients cannot be read", async () => {
    readFails = "enrollments";
    expect((await dispatch()).status).toBe(500);
    expect(sends).toHaveLength(0);
    expect(announcement().dispatched_at).toBeNull();
  });

  it("stays sendable when the classes cannot be read", async () => {
    readFails = "classes";
    expect((await dispatch()).status).toBe(500);
    expect(announcement().dispatched_at).toBeNull();
  });

  it("stays sendable when the bot is disabled", async () => {
    tables.tenant_bots[0].enabled = false;
    expect((await dispatch()).status).toBe(400);
    expect(sends).toHaveLength(0);
    expect(announcement().dispatched_at).toBeNull();
  });

  it("stays sendable when the token cannot be decrypted", async () => {
    tables.tenant_bots[0].bot_token = "not-a-real-ciphertext";
    expect((await dispatch()).status).toBe(500);
    expect(announcement().dispatched_at).toBeNull();
  });

  it("does not let staff send", async () => {
    role = "staff";
    expect((await dispatch()).status).toBe(403);
    expect(sends).toHaveLength(0);
    expect(announcement().dispatched_at).toBeNull();
  });
});

describe("what a send records", () => {
  it("records a finished send", async () => {
    const res = await dispatch();
    expect(await res.json()).toEqual({ sent: 2, failed: 0, unsent: 0, completed: true });
    expect(announcement()).toMatchObject({
      telegram_recipient_count: 2,
      telegram_sent_count: 2,
      telegram_failed_count: 0,
    });
    expect(announcement().dispatched_at).toBeTruthy();
    expect(announcement().dispatch_completed_at).toBeTruthy();
  });

  it("counts a rejected message and a dropped connection as failed", async () => {
    respond = (chatId) => {
      if (chatId === "501") return new Response("{}", { status: 403 });
      throw new Error("socket hang up");
    };
    const body = await (await dispatch()).json();
    expect(body).toEqual({ sent: 0, failed: 2, unsent: 0, completed: true });
  });

  it("finishes at once when nobody qualifies", async () => {
    tables.enrollments = [enrollment("1", { status: "rejected" })];
    const body = await (await dispatch()).json();
    expect(body).toMatchObject({ sent: 0, failed: 0, unsent: 0, completed: true });
    expect(announcement().dispatch_completed_at).toBeTruthy();
    expect(sends).toHaveLength(0);
  });

  it("saves progress before the next batch, so a killed function leaves the real count", async () => {
    vi.useFakeTimers();
    tables.enrollments = manyEnrollments(60);
    const pending = dispatch();
    await vi.advanceTimersByTimeAsync(500);

    expect(sends).toHaveLength(25);
    expect(announcement().telegram_sent_count).toBe(25);
    expect(announcement().telegram_recipient_count).toBe(60);
    expect(announcement().dispatch_completed_at).toBeNull();

    await vi.advanceTimersByTimeAsync(5000);
    await pending;
  });
});

describe("pacing", () => {
  it("sends at most 25 messages in any second", async () => {
    vi.useFakeTimers();
    tables.enrollments = manyEnrollments(120);
    const pending = dispatch();
    await vi.advanceTimersByTimeAsync(10_000);
    const body = await (await pending).json();

    expect(body).toEqual({ sent: 120, failed: 0, unsent: 0, completed: true });
    const times = sends.map((s) => s.at);
    for (const start of times) {
      expect(times.filter((t) => t >= start && t < start + 1000).length).toBeLessThanOrEqual(25);
    }
  });

  it("gives every request a timeout", async () => {
    await dispatch();
    expect(sends.every((s) => s.signal instanceof AbortSignal)).toBe(true);
  });

  it("waits as long as Telegram asks and retries a rate-limited message", async () => {
    vi.useFakeTimers();
    tables.enrollments = [enrollment("501")];
    respond = (_chatId, attempt) => (attempt === 1 ? rateLimited(3) : ok());
    const pending = dispatch();
    await vi.advanceTimersByTimeAsync(10_000);
    const body = await (await pending).json();

    expect(body).toEqual({ sent: 1, failed: 0, unsent: 0, completed: true });
    expect(sends).toHaveLength(2);
    expect(sends[1].at - sends[0].at).toBeGreaterThanOrEqual(3000);
  });

  it("counts a message as failed if it is rate-limited twice", async () => {
    vi.useFakeTimers();
    tables.enrollments = [enrollment("501")];
    respond = () => rateLimited(1);
    const pending = dispatch();
    await vi.advanceTimersByTimeAsync(10_000);
    const body = await (await pending).json();

    expect(body).toEqual({ sent: 0, failed: 1, unsent: 0, completed: true });
    expect(sends).toHaveLength(2);
  });

  it("stops inside the time limit and records who was not sent to", async () => {
    vi.useFakeTimers();
    tables.enrollments = manyEnrollments(2000);
    const pending = dispatch();
    await vi.advanceTimersByTimeAsync(60_000);
    const body = await (await pending).json();

    expect(body.completed).toBe(false);
    expect(body.sent).toBeGreaterThan(0);
    expect(body.sent + body.unsent).toBe(2000);
    expect(new Set(sends.map((s) => s.chatId)).size).toBe(sends.length);
    expect(sends[sends.length - 1].at - sends[0].at).toBeLessThan(55_000);
    expect(announcement().dispatch_completed_at).toBeNull();
    expect(announcement().telegram_recipient_count).toBe(2000);
    expect(announcement().telegram_sent_count).toBe(body.sent);
  });

  it("stops rather than wait past the limit when Telegram asks for too long", async () => {
    vi.useFakeTimers();
    respond = () => rateLimited(120);
    const pending = dispatch();
    await vi.advanceTimersByTimeAsync(60_000);
    const body = await (await pending).json();

    expect(body).toEqual({ sent: 0, failed: 0, unsent: 2, completed: false });
    expect(sends).toHaveLength(2);
  });

  it("declares a function limit longer than the time it will send for", async () => {
    const { maxDuration } = await import("@/app/api/admin/announcements/[id]/dispatch/route");
    expect(maxDuration).toBe(60);
  });
});

describe("message text", () => {
  it("escapes what an admin typed, so Telegram does not reject it for everyone", async () => {
    announcement().message = "Bring <ID> & receipt";
    announcement().target_label = "N5 <A>";
    await dispatch();
    expect(sends[0].text).toContain("Bring &lt;ID&gt; &amp; receipt");
    expect(sends[0].text).toContain("<b>N5 &lt;A&gt;</b>");
  });

  it("refuses a message over Telegram's limit before claiming it", async () => {
    announcement().message = "x".repeat(4100);
    const res = await dispatch();
    expect(res.status).toBe(400);
    expect(sends).toHaveLength(0);
    expect(announcement().dispatched_at).toBeNull();
  });
});

describe("POST /api/admin/announcements", () => {
  it("saves without sending, even when asked to send", async () => {
    tables.announcements = [];
    tables.intakes = [{ id: "int-1", tenant_id: "ten-1", name: "April" }];
    const originalFrom = client.from;
    client.from = ((table: string) => {
      const chain = originalFrom(table);
      chain.insert = (values: Row) => ({
        select: () => ({ single: async () => ({ data: { id: "new", ...values }, error: null }) }),
      });
      return chain;
    }) as typeof client.from;

    try {
      const { POST } = await import("@/app/api/admin/announcements/route");
      const res = await POST(new NextRequest("https://t.kuunyi.com/api/admin/announcements", {
        method: "POST",
        body: JSON.stringify({ intake_id: "int-1", message: "Hi", dispatch_telegram: true }),
      }));
      expect(res.status).toBe(201);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      client.from = originalFrom;
    }
  });
});

describe("saveAndSendAnnouncement", () => {
  const load = async () => (await import("@/lib/announcements/saveAndSendAnnouncement")).saveAndSendAnnouncement;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  let calls: string[];

  function stubAdminApi(dispatchResult: () => Response | Promise<Response>) {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return url.endsWith("/dispatch") ? dispatchResult() : json({ id: "ann-9", dispatched_at: null }, 201);
    }));
  }

  it("saves once, then sends that same announcement by id", async () => {
    stubAdminApi(() => json({ sent: 3, failed: 1, unsent: 0, completed: true }));
    const result = await (await load())({ intake_id: "int-1", message: "Hi" }, true);
    expect(calls).toEqual(["/api/admin/announcements", "/api/admin/announcements/ann-9/dispatch"]);
    expect(result).toMatchObject({
      saved: true,
      send: { state: "finished", sent: 3, failed: 1, unsent: 0, completed: true },
    });
  });

  it("does not send when the box is not ticked", async () => {
    stubAdminApi(() => json({}));
    const result = await (await load())({ intake_id: "int-1", message: "Hi" }, false);
    expect(calls).toEqual(["/api/admin/announcements"]);
    expect(result).toMatchObject({ saved: true, send: { state: "not_requested" } });
  });

  it("reports a refused send with the server's reason", async () => {
    stubAdminApi(() => json({ error: "Telegram bot is not connected or enabled." }, 400));
    const result = await (await load())({ intake_id: "int-1", message: "Hi" }, true);
    expect(result).toMatchObject({
      saved: true,
      send: { state: "refused", reason: "Telegram bot is not connected or enabled." },
    });
  });

  it("calls a lost connection unknown, because the send may still be running", async () => {
    stubAdminApi(() => {
      throw new Error("network down");
    });
    const result = await (await load())({ intake_id: "int-1", message: "Hi" }, true);
    expect(result).toMatchObject({ saved: true, send: { state: "unknown" } });
    expect(calls.filter((c) => c.endsWith("/dispatch"))).toHaveLength(1);
  });

  it("calls a platform timeout unknown too", async () => {
    stubAdminApi(() => new Response("gateway timeout", { status: 504 }));
    const result = await (await load())({ intake_id: "int-1", message: "Hi" }, true);
    expect(result).toMatchObject({ saved: true, send: { state: "unknown" } });
  });

  it("does not send when the save fails", async () => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return json({ message: "Intake not found." }, 404);
    }));
    const result = await (await load())({ intake_id: "int-1", message: "Hi" }, true);
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ saved: false, reason: "Intake not found." });
  });
});

describe("telegramBotIsReady", () => {
  const load = async () => (await import("@/lib/telegram/telegramBotIsReady")).telegramBotIsReady;

  async function settings() {
    const { GET } = await import("@/app/api/telegram/settings/route");
    return (await GET()).json();
  }

  it("is true for what /api/telegram/settings really returns", async () => {
    expect((await load())(await settings())).toBe(true);
  });

  it("is false when the bot is switched off", async () => {
    tables.tenant_bots[0].enabled = false;
    expect((await load())(await settings())).toBe(false);
  });

  it("is false when no bot is connected", async () => {
    tables.tenant_bots = [];
    expect((await load())(await settings())).toBe(false);
  });

  it("ignores a support bot", async () => {
    tables.tenant_bots[0].bot_type = "support";
    expect((await load())(await settings())).toBe(false);
  });

  it("is false for the 403 body staff get", async () => {
    expect((await load())({ error: "Forbidden", message: "Owner access required." })).toBe(false);
  });

  it.each(["src/app/admin/announcements/page.tsx", "src/app/admin/intakes/[id]/page.tsx"])(
    "%s uses it, not a top-level connected field",
    (file) => {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).toContain("telegramBotIsReady(");
      expect(source).not.toMatch(/(data|tgData)\.connected/);
    },
  );
});
