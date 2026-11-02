import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── In-memory stand-in for the admin client ────────────────────────────────
// It applies each filter for real, and each write atomically, so claims and
// guarded status writes can race the way they do in Postgres. `failNext` and
// `gate` inject read errors, write errors and slow queries by kind of query.

type Row = Record<string, unknown>;
type Kind = "read" | "claim" | "finish";
type DbError = { code: string; message: string };

let db: Record<string, Row[]>;
let selects: Record<string, string[]>;
let orFilters: string[];
let writes: { kind: Kind; patch: Row; matched: number }[];
let fail: (table: string, kind: Kind, patch: Row | null) => DbError | "throw" | undefined;
let gate: (table: string, kind: Kind) => Promise<void> | undefined;

/** Handles the one `.or()` shape the sender uses. */
function orFilterToPredicate(expr: string): (r: Row) => boolean {
  const match = /^last_attempt_at\.is\.null,last_attempt_at\.lt\.(.+)$/.exec(expr);
  if (!match) throw new Error(`fake db: unexpected or filter ${expr}`);
  const cutoff = new Date(match[1].replace(/"/g, "")).getTime();
  return (r) =>
    r.last_attempt_at === null || new Date(r.last_attempt_at as string).getTime() < cutoff;
}

function fakeTable(table: string) {
  const predicates: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let sortBy: { column: string; ascending: boolean } | null = null;
  let maxRows: number | null = null;

  const execute = async () => {
    const kind: Kind = !patch ? "read" : "attempts" in patch ? "claim" : "finish";
    await Promise.resolve();
    await gate(table, kind);
    const failure = fail(table, kind, patch);
    if (failure === "throw") throw new Error("socket hang up tok-meta-secret");
    if (failure) return { data: null, error: failure };
    let rows = (db[table] ?? []).filter((r) => predicates.every((p) => p(r)));
    if (sortBy) {
      const { column, ascending } = sortBy;
      rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
    }
    if (maxRows !== null) rows = rows.slice(0, maxRows);
    if (patch) {
      for (const r of rows) Object.assign(r, patch);
      writes.push({ kind, patch, matched: rows.length });
    }
    return { data: rows.map((r) => ({ ...r })), error: null };
  };

  const builder = {
    select(columns: string) {
      if (!patch) (selects[table] ??= []).push(columns);
      return builder;
    },
    update(next: Row) {
      patch = next;
      return builder;
    },
    eq(column: string, value: unknown) {
      predicates.push((r) => r[column] === value);
      return builder;
    },
    or(expr: string) {
      orFilters.push(expr);
      predicates.push(orFilterToPredicate(expr));
      return builder;
    },
    order(column: string, options: { ascending: boolean }) {
      sortBy = { column, ascending: options.ascending };
      return builder;
    },
    limit(n: number) {
      maxRows = n;
      return builder;
    },
    async maybeSingle() {
      const { data, error } = await execute();
      return { data: data?.[0] ?? null, error };
    },
    then<T>(resolve: (v: { data: Row[] | null; error: DbError | null }) => T, reject?: (e: unknown) => T) {
      return execute().then(resolve, reject);
    },
  };
  return builder;
}

const mockCreateAdminClient = vi.fn(() => ({
  from: (table: string) => fakeTable(table),
  // Only the cron's clean-up calls this.
  rpc: async () => ({ data: [{ expired: 0, context_deleted: 0 }], error: null }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

const { decideRow, sendPendingConversions } = await import("@/server/conversions/sendPendingConversions");
const { sweepConversions } = await import("@/server/conversions/sweep");

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ENROLLMENT = "enr-1";
const CLIENT_IP = "203.0.113.77";
const FBP = "fb.1.1700000000.fbp-sentinel";
const FBC = "fb.1.1700000000.fbc-sentinel";
const TTP = "ttp-sentinel";
const TTCLID = "ttclid-sentinel";
const META_TOKEN = "tok-meta-secret";
const TIKTOK_TOKEN = "tok-tiktok-secret";
const BODY_SENTINEL = "response-body-sentinel";

const queueRow = (platform: "meta" | "tiktok", over: Row = {}): Row => ({
  id: `row-${platform}`,
  enrollment_id: ENROLLMENT,
  tenant_id: "ten-1",
  platform,
  event_id: "event-hash",
  value: 12.5,
  currency: "USD",
  occurred_at: "2026-11-02T10:00:00.000Z",
  status: "pending",
  attempts: 0,
  last_attempt_at: null,
  last_error: null,
  ...over,
});

const row = (id: string) => db.conversion_events.find((r) => r.id === id)!;
const metaRow = () => row("row-meta");
const tiktokRow = () => row("row-tiktok");
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

type FakeResponse = { status: number; json: () => Promise<unknown> };
const respond = (status: number, body: unknown): FakeResponse => ({ status, json: async () => body });
const metaOk = () => respond(200, { events_received: 1 });
const tiktokOk = () => respond(200, { code: 0, message: "OK" });

const mockFetch = vi.fn<(url: string, init: RequestInit) => Promise<FakeResponse>>();
const fetchedUrls = () => mockFetch.mock.calls.map(([url]) => url);
const fetchedBody = (index = 0) => JSON.parse(mockFetch.mock.calls[index][1].body as string);

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const logged = () =>
  JSON.stringify([...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]);

beforeEach(() => {
  mockCreateAdminClient.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url) => (url.includes("facebook") ? metaOk() : tiktokOk()));
  vi.stubGlobal("fetch", mockFetch);

  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("CONVERSIONS_SKY_META_TOKEN", META_TOKEN);
  vi.stubEnv("CONVERSIONS_SKY_TIKTOK_TOKEN", TIKTOK_TOKEN);

  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

  selects = {};
  orFilters = [];
  writes = [];
  fail = () => undefined;
  gate = () => undefined;
  db = {
    conversion_events: [queueRow("meta"), queueRow("tiktok")],
    tenant_conversion_settings: [
      { tenant_id: "ten-1", enabled: true, config_id: "SKY", meta_pixel_id: "111", tiktok_pixel_code: "PIX" },
    ],
    enrollments: [
      {
        id: ENROLLMENT,
        status: "confirmed",
        internal_test_at: null,
        // Present so a test can prove none of it travels.
        student_name_en: "Buyer Name",
        email: "buyer@example.com",
        phone: "+95900000000",
        enrollment_ref: "ORDER-REF-1",
      },
    ],
    enrollment_ad_context: [
      {
        enrollment_id: ENROLLMENT,
        fbp: FBP,
        fbc: FBC,
        ttp: TTP,
        ttclid: TTCLID,
        client_ip: CLIENT_IP,
        user_agent: "UA/1.0",
        source_url: "https://sky.example.com/enroll/x",
      },
    ],
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── The per-row decision ───────────────────────────────────────────────────

const settings = { enabled: true, config_id: "SKY", meta_pixel_id: "1", tiktok_pixel_code: "P" };
const enrollment = { status: "confirmed", internal_test_at: null };
const context = { fbp: "f", fbc: null, ttp: null, ttclid: null };

describe("decideRow", () => {
  it("sends when everything is present", () => expect(decideRow("meta", settings, enrollment, context)).toBe("send"));
  it("skips an unconfirmed enrollment", () =>
    expect(decideRow("meta", settings, { ...enrollment, status: "rejected" }, context)).toBe("skip"));
  it("skips a missing enrollment", () => expect(decideRow("meta", settings, null, context)).toBe("skip"));
  it("skips an internal test order", () =>
    expect(decideRow("meta", settings, { ...enrollment, internal_test_at: "x" }, context)).toBe("skip"));
  it("skips when settings are missing or disabled", () => {
    expect(decideRow("meta", null, enrollment, context)).toBe("skip");
    expect(decideRow("meta", { ...settings, enabled: false }, enrollment, context)).toBe("skip");
  });
  it("skips when that platform's pixel is null", () => {
    expect(decideRow("tiktok", { ...settings, tiktok_pixel_code: null }, enrollment, { ...context, ttp: "t" })).toBe("skip");
    expect(decideRow("meta", { ...settings, meta_pixel_id: null }, enrollment, context)).toBe("skip");
  });
  it("skips when there is no ad context", () => expect(decideRow("meta", settings, enrollment, null)).toBe("skip"));
  it("requires each platform's own click data", () => {
    expect(decideRow("tiktok", settings, enrollment, context)).toBe("skip");
    expect(decideRow("meta", settings, enrollment, { ...context, fbp: null, ttclid: "t" })).toBe("skip");
    expect(decideRow("tiktok", settings, enrollment, { ...context, ttclid: "t" })).toBe("send");
    expect(decideRow("meta", settings, enrollment, { ...context, fbp: null, fbc: "c" })).toBe("send");
    expect(decideRow("tiktok", settings, enrollment, { ...context, ttp: "t" })).toBe("send");
  });
});

// ─── Normal outcomes ────────────────────────────────────────────────────────

describe("sendPendingConversions", () => {
  it("does nothing, and sends nothing, when there are no pending rows", async () => {
    db.conversion_events = [queueRow("meta", { status: "sent" }), queueRow("tiktok", { status: "failed" })];

    await sendPendingConversions(ENROLLMENT);

    expect(selects.conversion_events).toHaveLength(1);
    expect(selects.tenant_conversion_settings).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("leaves rows pending with attempts unchanged when the mode is hold", async () => {
    vi.stubEnv("CONVERSIONS_SKY_META_TOKEN", "");
    vi.stubEnv("CONVERSIONS_SKY_TIKTOK_TOKEN", "");

    await sendPendingConversions(ENROLLMENT);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 0, last_attempt_at: null });
    expect(tiktokRow()).toMatchObject({ status: "pending", attempts: 0, last_attempt_at: null });
    // Names the variable so the owner can fix it.
    expect(logged()).toContain("missing CONVERSIONS_SKY_META_TOKEN");
    expect(logged()).toContain("missing CONVERSIONS_SKY_TIKTOK_TOKEN");
  });

  it("holds one platform while the other sends", async () => {
    vi.stubEnv("CONVERSIONS_SKY_TIKTOK_TOKEN", "");

    await sendPendingConversions(ENROLLMENT);

    expect(fetchedUrls()).toHaveLength(1);
    expect(fetchedUrls()[0]).toContain("facebook");
    expect(metaRow()).toMatchObject({ status: "sent", attempts: 1 });
    expect(tiktokRow()).toMatchObject({ status: "pending", attempts: 0, last_attempt_at: null });
  });

  it("sends nothing and stays quiet outside production with no test code", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");

    await sendPendingConversions(ENROLLMENT);

    expect(selects.tenant_conversion_settings).toHaveLength(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 0 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("sends with the test code outside production, and without one in production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CONVERSIONS_SKY_META_TEST_CODE", "TEST123");

    await sendPendingConversions(ENROLLMENT);

    expect(fetchedUrls()).toHaveLength(1);
    expect(fetchedBody().test_event_code).toBe("TEST123");

    mockFetch.mockClear();
    vi.stubEnv("VERCEL_ENV", "production");
    db.conversion_events = [queueRow("meta")];

    await sendPendingConversions(ENROLLMENT);

    expect(fetchedBody().test_event_code).toBeUndefined();
  });

  it("marks a skipped row without calling fetch or moving attempts", async () => {
    db.enrollment_ad_context = [];

    await sendPendingConversions(ENROLLMENT);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(metaRow()).toMatchObject({ status: "skipped", last_error: "not_eligible", attempts: 0, last_attempt_at: null });
    expect(tiktokRow()).toMatchObject({ status: "skipped", last_error: "not_eligible", attempts: 0, last_attempt_at: null });
  });

  it("skips per platform when only one has click data", async () => {
    db.enrollment_ad_context[0] = { ...db.enrollment_ad_context[0], ttp: null, ttclid: null };

    await sendPendingConversions(ENROLLMENT);

    expect(fetchedUrls()).toHaveLength(1);
    expect(metaRow()).toMatchObject({ status: "sent", attempts: 1 });
    expect(tiktokRow()).toMatchObject({ status: "skipped", last_error: "not_eligible", attempts: 0 });
  });

  it("skips an unconfirmed enrollment and an internal test order", async () => {
    db.enrollments[0].status = "rejected";
    await sendPendingConversions(ENROLLMENT);
    expect(metaRow()).toMatchObject({ status: "skipped", last_error: "not_eligible" });

    db.conversion_events = [queueRow("meta")];
    db.enrollments[0] = { ...db.enrollments[0], status: "confirmed", internal_test_at: "2026-11-01T00:00:00Z" };
    await sendPendingConversions(ENROLLMENT);
    expect(metaRow()).toMatchObject({ status: "skipped", last_error: "not_eligible" });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips queued rows of a disabled tenant even when its token is already gone", async () => {
    db.tenant_conversion_settings[0].enabled = false;
    vi.stubEnv("CONVERSIONS_SKY_META_TOKEN", "");

    await sendPendingConversions(ENROLLMENT);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(metaRow()).toMatchObject({ status: "skipped", last_error: "disabled", attempts: 0 });
    expect(tiktokRow()).toMatchObject({ status: "skipped", last_error: "disabled", attempts: 0 });
  });

  it("skips when the settings row genuinely does not exist", async () => {
    db.tenant_conversion_settings = [];

    await sendPendingConversions(ENROLLMENT);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(metaRow()).toMatchObject({ status: "skipped", last_error: "disabled" });
  });

  it("records sent, failed and pending outcomes per platform", async () => {
    mockFetch.mockImplementation(async (url) =>
      url.includes("facebook") ? metaOk() : respond(200, { code: 40000, message: "bad request" }),
    );
    await sendPendingConversions(ENROLLMENT);
    expect(metaRow()).toMatchObject({ status: "sent", last_error: null, attempts: 1 });
    expect(tiktokRow()).toMatchObject({ status: "failed", last_error: "tiktok_40000", attempts: 1 });

    db.conversion_events = [queueRow("meta"), queueRow("tiktok")];
    mockFetch.mockImplementation(async (url) =>
      url.includes("facebook") ? respond(500, null) : tiktokOk(),
    );
    await sendPendingConversions(ENROLLMENT);
    expect(metaRow()).toMatchObject({ status: "pending", last_error: "http_500", attempts: 1 });
    expect(tiktokRow()).toMatchObject({ status: "sent", last_error: null, attempts: 1 });
  });

  it("keeps a timed-out send pending, with a timeout on every request", async () => {
    mockFetch.mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));

    await sendPendingConversions(ENROLLMENT);

    expect(metaRow()).toMatchObject({ status: "pending", last_error: "transport", attempts: 1 });
    expect(tiktokRow()).toMatchObject({ status: "pending", last_error: "transport", attempts: 1 });
    expect(metaRow().last_attempt_at).toEqual(expect.any(String));
    for (const [, init] of mockFetch.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  describe("a response body that can't be read", () => {
    const unreadable = (status: number, error: unknown): FakeResponse => ({
      status,
      json: () => Promise.reject(error),
    });

    it.each(["TimeoutError", "AbortError"])(
      "keeps a 200 pending when reading the body ends in %s",
      async (name) => {
        // Each would be permanent or wrong if read as "no body": TikTok failed
        // with http_200, and Meta sent.
        mockFetch.mockImplementation(async () => unreadable(200, new DOMException("stalled", name)));

        await sendPendingConversions(ENROLLMENT);

        expect(metaRow()).toMatchObject({ status: "pending", last_error: "transport", attempts: 1 });
        expect(tiktokRow()).toMatchObject({ status: "pending", last_error: "transport", attempts: 1 });
      },
    );

    it("treats plain invalid JSON as no body", async () => {
      mockFetch.mockImplementation(async () => unreadable(200, new SyntaxError("Unexpected token <")));

      await sendPendingConversions(ENROLLMENT);

      expect(metaRow()).toMatchObject({ status: "sent", last_error: null });
      expect(tiktokRow()).toMatchObject({ status: "failed", last_error: "http_200" });
    });
  });

  it("records only a code in last_error", async () => {
    mockFetch.mockImplementation(async (url) =>
      url.includes("facebook")
        ? respond(400, { error: { code: 100, message: BODY_SENTINEL } })
        : respond(200, { code: 40002, message: BODY_SENTINEL }),
    );

    await sendPendingConversions(ENROLLMENT);

    expect(metaRow().last_error).toBe("meta_100");
    expect(tiktokRow().last_error).toBe("tiktok_40002");
    expect(JSON.stringify(writes)).not.toContain(BODY_SENTINEL);
  });

  it("asks Next not to cache the request", async () => {
    await sendPendingConversions(ENROLLMENT);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mockFetch.mock.calls) expect(init.cache).toBe("no-store");
  });

  it("gives each send 2.5 seconds", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await sendPendingConversions(ENROLLMENT);

    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledWith(2500);
  });

  it("sends a number when PostgREST returns value as a string", async () => {
    db.conversion_events = [queueRow("meta", { value: "12.50" }), queueRow("tiktok", { value: "12.50" })];

    await sendPendingConversions(ENROLLMENT);

    const meta = JSON.parse(mockFetch.mock.calls.find(([url]) => url.includes("facebook"))![1].body as string);
    const tiktok = JSON.parse(mockFetch.mock.calls.find(([url]) => url.includes("tiktok"))![1].body as string);
    expect(meta.data[0].custom_data.value).toBe(12.5);
    expect(tiktok.data[0].properties.value).toBe(12.5);
  });

  it("reads occurred_at in PostgREST form, with +00:00 and microseconds", async () => {
    db.conversion_events = [queueRow("meta", { occurred_at: "2026-11-02T10:00:00.123456+00:00" })];

    await sendPendingConversions(ENROLLMENT);

    expect(fetchedBody().data[0].event_time).toBe(Date.UTC(2026, 10, 2, 10, 0, 0) / 1000);
  });

  it("copies the queue row and ad context into the request, and nothing about the buyer", async () => {
    await sendPendingConversions(ENROLLMENT);

    expect(selects.enrollments).toEqual(["status, internal_test_at"]);
    const meta = mockFetch.mock.calls.find(([url]) => url.includes("facebook"))!;
    const tiktok = mockFetch.mock.calls.find(([url]) => url.includes("tiktok"))!;
    expect(meta[0]).toContain("/111/events");
    expect(meta[0]).not.toContain(META_TOKEN);
    expect(tiktok[0]).not.toContain(TIKTOK_TOKEN);

    const metaBody = JSON.parse(meta[1].body as string);
    expect(metaBody.data[0]).toMatchObject({
      event_id: "event-hash",
      event_source_url: "https://sky.example.com/enroll/x",
      user_data: { client_ip_address: CLIENT_IP, client_user_agent: "UA/1.0", fbp: FBP, fbc: FBC },
      custom_data: { value: 12.5, currency: "USD" },
    });
    const tiktokBody = JSON.parse(tiktok[1].body as string);
    expect(tiktokBody.event_source_id).toBe("PIX");
    expect(tiktokBody.data[0]).toMatchObject({
      event_id: "event-hash",
      user: { ttclid: TTCLID, ttp: TTP, ip: CLIENT_IP, user_agent: "UA/1.0" },
      properties: { value: 12.5, currency: "USD" },
    });

    for (const [, init] of mockFetch.mock.calls) {
      const sent = init.body as string;
      for (const buyerData of ["Buyer Name", "buyer@example.com", "+95900000000", "ORDER-REF-1"]) {
        expect(sent).not.toContain(buyerData);
      }
    }
  });

  it("never throws, even if the database client throws", async () => {
    mockCreateAdminClient.mockImplementationOnce(() => {
      throw new Error(`no client ${META_TOKEN}`);
    });

    await expect(sendPendingConversions(ENROLLMENT)).resolves.toBeUndefined();

    expect(logged()).toContain("[conversions]");
    expect(logged()).not.toContain(META_TOKEN);
  });

  it("logs no token, IP, click ID or response body", async () => {
    // A run that hits every failure at once: rejected and thrown sends, and a
    // write that errors with a message full of sensitive values.
    const sensitive = [META_TOKEN, TIKTOK_TOKEN, CLIENT_IP, FBP, FBC, TTP, TTCLID, BODY_SENTINEL];
    mockFetch.mockImplementation(async (url) => {
      if (url.includes("facebook")) throw new Error(`connect failed ${META_TOKEN} ${CLIENT_IP} ${FBP}`);
      return respond(400, { code: 40002, message: `${BODY_SENTINEL} ${TTCLID} ${TTP}` });
    });
    fail = (_table, kind) =>
      kind === "finish" ? { code: "XX000", message: `write failed ${FBC} ${TIKTOK_TOKEN} ${CLIENT_IP}` } : undefined;

    await sendPendingConversions(ENROLLMENT);

    expect(errorSpy).toHaveBeenCalled();
    for (const value of sensitive) expect(logged()).not.toContain(value);
  });
});

// ─── Point: the claim ───────────────────────────────────────────────────────

describe("sendPendingConversions claims", () => {
  it("quotes the timestamp in the stale filter", async () => {
    await sendPendingConversions(ENROLLMENT);

    expect(orFilters).toHaveLength(1);
    expect(orFilters[0]).toMatch(
      /^last_attempt_at\.is\.null,last_attempt_at\.lt\."\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/,
    );
  });

  it("re-claims a stale claim older than 5 minutes", async () => {
    db.conversion_events = [queueRow("meta", { attempts: 2, last_attempt_at: minutesAgo(5.1) })];

    await sendPendingConversions(ENROLLMENT);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(metaRow()).toMatchObject({ status: "sent", attempts: 3 });
    expect(new Date(metaRow().last_attempt_at as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("does not send a row claimed within the last 5 minutes", async () => {
    db.conversion_events = [queueRow("meta", { attempts: 2, last_attempt_at: minutesAgo(4.9) })];

    await sendPendingConversions(ENROLLMENT);

    expect(orFilters).toHaveLength(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 2 });
  });

  it("sends once when two runs race for the same fresh rows", async () => {
    await Promise.all([sendPendingConversions(ENROLLMENT), sendPendingConversions(ENROLLMENT)]);

    expect(mockFetch).toHaveBeenCalledTimes(2); // once per platform, not per run
    expect(fetchedUrls().filter((u) => u.includes("facebook"))).toHaveLength(1);
    expect(metaRow()).toMatchObject({ status: "sent", attempts: 1 });
    expect(tiktokRow()).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("sends once when two runs race for the same stale row", async () => {
    db.conversion_events = [queueRow("meta", { attempts: 4, last_attempt_at: minutesAgo(30) })];

    await Promise.all([sendPendingConversions(ENROLLMENT), sendPendingConversions(ENROLLMENT)]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(metaRow()).toMatchObject({ status: "sent", attempts: 5 });
  });

  it("does not send when the claim write fails, and leaves the row pending", async () => {
    db.conversion_events = [queueRow("meta")];
    fail = (_table, kind) => (kind === "claim" ? { code: "40001", message: "serialization" } : undefined);

    await sendPendingConversions(ENROLLMENT);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 0 });
    expect(logged()).toContain("40001");
  });
});

// ─── Point: a failed read is not "no data" ──────────────────────────────────

describe("sendPendingConversions read failures", () => {
  const expectUntouched = () => {
    expect(mockFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 0, last_attempt_at: null, last_error: null });
    expect(tiktokRow()).toMatchObject({ status: "pending", attempts: 0, last_attempt_at: null, last_error: null });
  };

  it("stops when the queue read fails", async () => {
    fail = (table, kind) =>
      table === "conversion_events" && kind === "read" ? { code: "57014", message: "timeout" } : undefined;

    await sendPendingConversions(ENROLLMENT);

    expectUntouched();
    expect(selects.tenant_conversion_settings).toBeUndefined();
    expect(logged()).toContain("57014");
  });

  it("does not skip rows when the settings read fails", async () => {
    fail = (table) =>
      table === "tenant_conversion_settings" ? { code: "57014", message: "timeout" } : undefined;

    await sendPendingConversions(ENROLLMENT);

    expectUntouched();
    expect(logged()).toContain("57014");
  });

  it("does not skip rows when the settings read throws", async () => {
    fail = (table) => (table === "tenant_conversion_settings" ? "throw" : undefined);

    await expect(sendPendingConversions(ENROLLMENT)).resolves.toBeUndefined();

    expectUntouched();
    expect(logged()).toContain("[conversions]");
  });

  it("does not skip rows when the enrollment read fails", async () => {
    fail = (table) => (table === "enrollments" ? { code: "08006", message: "connection" } : undefined);

    await sendPendingConversions(ENROLLMENT);

    expectUntouched();
    expect(logged()).toContain("08006");
  });

  it("does not skip rows when the ad context read fails", async () => {
    fail = (table) => (table === "enrollment_ad_context" ? { code: "08006", message: "connection" } : undefined);

    await sendPendingConversions(ENROLLMENT);

    expectUntouched();
    expect(logged()).toContain("08006");
  });

  it("does not skip rows when the enrollment read throws", async () => {
    fail = (table) => (table === "enrollments" ? "throw" : undefined);

    await expect(sendPendingConversions(ENROLLMENT)).resolves.toBeUndefined();

    expectUntouched();
    expect(logged()).toContain("[conversions]");
  });

  it("sends on the next run once the read recovers, with no wait for a claim to go stale", async () => {
    fail = (table) => (table === "enrollment_ad_context" ? { code: "08006", message: "connection" } : undefined);
    await sendPendingConversions(ENROLLMENT);
    expect(mockFetch).not.toHaveBeenCalled();

    fail = () => undefined;
    await sendPendingConversions(ENROLLMENT);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(metaRow()).toMatchObject({ status: "sent", attempts: 1 });
    expect(tiktokRow()).toMatchObject({ status: "sent", attempts: 1 });
  });
});

// ─── Point: a failed status write after a send ──────────────────────────────

describe("sendPendingConversions status writes", () => {
  it("stays pending and says so when the write fails after a successful send", async () => {
    db.conversion_events = [queueRow("meta")];
    fail = (_table, kind) => (kind === "finish" ? { code: "08006", message: "connection" } : undefined);

    await expect(sendPendingConversions(ENROLLMENT)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 1, last_error: null });
    expect(logged()).toContain("status not recorded");
    expect(logged()).toContain("08006");
  });

  it("stays pending and says so when the write throws after a successful send", async () => {
    db.conversion_events = [queueRow("meta")];
    fail = (_table, kind) => (kind === "finish" ? "throw" : undefined);

    await expect(sendPendingConversions(ENROLLMENT)).resolves.toBeUndefined();

    expect(metaRow()).toMatchObject({ status: "pending", attempts: 1 });
    expect(logged()).toContain("status not recorded");
  });

  it("does not let one failed write lose the other platform's outcome", async () => {
    fail = (_table, kind, patch) =>
      kind === "finish" && patch?.status === "failed" ? "throw" : undefined;
    mockFetch.mockImplementation(async (url) =>
      url.includes("facebook") ? respond(200, { code: undefined }) : respond(200, { code: 40000 }),
    );

    await sendPendingConversions(ENROLLMENT);

    expect(metaRow()).toMatchObject({ status: "sent" });
    expect(tiktokRow()).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("re-sends the same event_id later, so the platform can deduplicate", async () => {
    db.conversion_events = [queueRow("meta")];
    fail = (_table, kind) => (kind === "finish" ? { code: "08006", message: "connection" } : undefined);
    await sendPendingConversions(ENROLLMENT);

    fail = () => undefined;
    metaRow().last_attempt_at = minutesAgo(6);
    await sendPendingConversions(ENROLLMENT);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(fetchedBody(1).data[0].event_id).toBe(fetchedBody(0).data[0].event_id);
    expect(metaRow()).toMatchObject({ status: "sent", attempts: 2 });
  });
});

// ─── A cron run goes through the same environment rules ─────────────────────

describe("sweepConversions through the real sender", () => {
  it("honours test codes on a non-production deployment", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CONVERSIONS_SKY_META_TEST_CODE", "TEST123");

    const counts = await sweepConversions();

    expect(counts.processed).toBe(1);
    expect(fetchedUrls()).toHaveLength(1);
    expect(fetchedUrls()[0]).toContain("facebook");
    expect(fetchedBody().test_event_code).toBe("TEST123");
    expect(metaRow()).toMatchObject({ status: "sent", attempts: 1 });
    // No test code for TikTok here, so that row is held, not sent live.
    expect(tiktokRow()).toMatchObject({ status: "pending", attempts: 0, last_attempt_at: null });
  });

  it("sends nothing on a non-production deployment with no test code", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");

    const counts = await sweepConversions();

    expect(counts.processed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 0 });
    expect(tiktokRow()).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("sends live, with no test code, in production even if one is set", async () => {
    vi.stubEnv("CONVERSIONS_SKY_META_TEST_CODE", "TEST123");

    await sweepConversions();

    expect(fetchedUrls()).toHaveLength(2);
    expect(fetchedBody(fetchedUrls().findIndex((u) => u.includes("facebook"))).test_event_code).toBeUndefined();
    expect(metaRow()).toMatchObject({ status: "sent" });
  });
});

// ─── Point: the deadline, and a late write ──────────────────────────────────

describe("sendPendingConversions deadline", () => {
  const deferredFetch = () => {
    let settle!: (r: FakeResponse) => void;
    mockFetch.mockImplementation(() => new Promise<FakeResponse>((resolve) => (settle = resolve)));
    return (r: FakeResponse) => settle(r);
  };

  it("resolves at its deadline even if fetch never settles", async () => {
    vi.useFakeTimers();
    db.conversion_events = [queueRow("meta")];
    mockFetch.mockImplementation(() => new Promise(() => undefined));

    let resolved = false;
    void sendPendingConversions(ENROLLMENT).then(() => (resolved = true));

    await vi.advanceTimersByTimeAsync(5999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    // Claimed, unfinished: the row stays pending for the retry.
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("starts no claim and no send once the deadline has passed", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const slowRead = new Promise<void>((resolve) => (release = resolve));
    gate = (table) => (table === "tenant_conversion_settings" ? slowRead : undefined);

    let resolved = false;
    void sendPendingConversions(ENROLLMENT).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(6000);
    expect(resolved).toBe(true);

    release();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(selects.tenant_conversion_settings).toHaveLength(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 0, last_attempt_at: null });
  });

  it("a late failed outcome cannot overwrite a later run's sent row", async () => {
    vi.useFakeTimers();
    db.conversion_events = [queueRow("meta")];
    const settle = deferredFetch();

    void sendPendingConversions(ENROLLMENT);
    await vi.advanceTimersByTimeAsync(6000);
    expect(metaRow()).toMatchObject({ status: "pending", attempts: 1 });

    // A later run re-claimed the stale row and finished it.
    Object.assign(metaRow(), { status: "sent", attempts: 2, last_error: null });

    settle(respond(400, { error: { code: 100 } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(metaRow()).toMatchObject({ status: "sent", attempts: 2, last_error: null });
    expect(writes.filter((w) => w.kind === "finish")).toEqual([
      { kind: "finish", patch: { status: "failed", last_error: "meta_100" }, matched: 0 },
    ]);
  });

  it("a late permanent outcome cannot end a row a later run is still sending", async () => {
    vi.useFakeTimers();
    db.conversion_events = [queueRow("meta")];
    const settle = deferredFetch();

    void sendPendingConversions(ENROLLMENT);
    await vi.advanceTimersByTimeAsync(6000);

    Object.assign(metaRow(), { attempts: 2 }); // a later run holds the claim now

    settle(respond(400, { error: { code: 100 } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(metaRow()).toMatchObject({ status: "pending", attempts: 2, last_error: null });
  });

  it("the holder of the claim can still record its outcome after the deadline", async () => {
    vi.useFakeTimers();
    db.conversion_events = [queueRow("meta")];
    const settle = deferredFetch();

    void sendPendingConversions(ENROLLMENT);
    await vi.advanceTimersByTimeAsync(6000);

    settle(metaOk());
    await vi.advanceTimersByTimeAsync(0);

    expect(metaRow()).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("a skip cannot overwrite a run that claimed the row first", async () => {
    let release!: () => void;
    const slowRead = new Promise<void>((resolve) => (release = resolve));
    gate = (table) => (table === "tenant_conversion_settings" ? slowRead : undefined);
    db.tenant_conversion_settings[0].enabled = false;

    const run = sendPendingConversions(ENROLLMENT);
    await vi.waitFor(() => expect(selects.tenant_conversion_settings).toHaveLength(1));

    Object.assign(metaRow(), { attempts: 1, last_attempt_at: new Date().toISOString() });
    release();
    await run;

    expect(metaRow()).toMatchObject({ status: "pending", attempts: 1 });
    expect(tiktokRow()).toMatchObject({ status: "skipped", last_error: "disabled" });
  });
});
