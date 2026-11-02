import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock the admin client ──────────────────────────────────────────────────

interface Call {
  table: string;
  filters: [string, unknown][];
  select?: string;
  upsert?: { row: Record<string, unknown>; options: Record<string, unknown> };
  signal?: AbortSignal;
}
let calls: Call[] = [];
let results: Record<string, { data?: unknown; error?: unknown }> = {};
let throwOn: string | null = null;
// A stalled query: it answers only when its signal aborts, the way a real fetch
// does, and never if no signal was passed.
let stallOn: string | null = null;

function builder(table: string) {
  const call: Call = { table, filters: [] };
  calls.push(call);
  const settle = () => {
    if (throwOn === table) throw new Error("client exploded with SECRET-VALUE");
    if (stallOn === table) {
      return new Promise<{ data: null; error: { code: string; message: string } }>((resolve) => {
        call.signal?.addEventListener("abort", () =>
          resolve({ data: null, error: { code: "", message: "TimeoutError: SECRET-VALUE" } }),
        );
      });
    }
    return Promise.resolve({ data: null, error: null, ...(results[table] ?? {}) });
  };
  const b: Record<string, unknown> = {
    select: (cols: string) => ((call.select = cols), b),
    eq: (k: string, v: unknown) => (call.filters.push([k, v]), b),
    abortSignal: (signal: AbortSignal) => ((call.signal = signal), b),
    maybeSingle: () => settle(),
    upsert: (row: Record<string, unknown>, options: Record<string, unknown>) => {
      call.upsert = { row, options };
      return b;
    },
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject),
  };
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => builder(t) }),
}));

const { adContextFromRequest, captureAdContext } = await import("@/server/conversions/captureAdContext");
const { tenantLinkOrigin } = await import("@/lib/origin");

// ─── Helpers ────────────────────────────────────────────────────────────────

const cookies = (o: Record<string, string>) => (name: string) => o[name];
const headers = new Headers({ "user-agent": "UA", "x-real-ip": "203.0.113.1" });
const ENROLLMENT_REF = "NM-2026-0001";

function args(over: Partial<Parameters<typeof captureAdContext>[0]> = {}) {
  return {
    cookie: cookies({ _fbp: "fb.1.1.1" }),
    headers,
    enrollmentId: "enroll-1",
    tenantId: "tenant-1",
    subdomain: "skyfestival",
    classId: "class-1",
    ...over,
  };
}

// ─── adContextFromRequest ───────────────────────────────────────────────────

describe("adContextFromRequest", () => {
  it("returns null when no click data is present", () => {
    expect(adContextFromRequest(cookies({}), headers)).toBeNull();
  });
  it("reads the pixel cookies", () => {
    expect(adContextFromRequest(cookies({ _fbp: "fb.1.1.1", _ttp: "ttp1" }), headers)).toMatchObject({
      fbp: "fb.1.1.1", ttp: "ttp1", fbc: null, ttclid: null, client_ip: "203.0.113.1", user_agent: "UA",
    });
  });
  it.each([
    ["fbp", { _fbp: "fb.1.1.1" }],
    ["fbc", { _fbc: "fb.1.9.P" }],
    ["ttp", { _ttp: "ttp1" }],
    ["ttclid", { kn_ad_click: encodeURIComponent(JSON.stringify({ ttclid: "T1", at: 1700 })) }],
  ])("stores context for a buyer with only %s", (_name, c) => {
    expect(adContextFromRequest(cookies(c), headers)).not.toBeNull();
  });
  it("builds fbc from our cookie when the pixel has not set one", () => {
    const raw = encodeURIComponent(JSON.stringify({ fbclid: "F1", ttclid: "T1", at: 1700 }));
    expect(adContextFromRequest(cookies({ kn_ad_click: raw }), headers)).toMatchObject({ fbc: "fb.1.1700.F1", ttclid: "T1" });
  });
  it("prefers the pixel's own _fbc", () => {
    const raw = encodeURIComponent(JSON.stringify({ fbclid: "F1", at: 1700 }));
    expect(adContextFromRequest(cookies({ kn_ad_click: raw, _fbc: "fb.1.9.P" }), headers)?.fbc).toBe("fb.1.9.P");
  });
  it("drops invalid values, and returns null if nothing is left", () => {
    expect(adContextFromRequest(cookies({ _fbp: "<script>" }), headers)).toBeNull();
  });
  it("stores null for an unknown IP", () => {
    expect(adContextFromRequest(cookies({ _fbp: "fb.1.1.1" }), new Headers())?.client_ip).toBeNull();
  });
  it("caps the user agent", () => {
    const long = new Headers({ "user-agent": "a".repeat(2000) });
    expect(adContextFromRequest(cookies({ _fbp: "fb.1.1.1" }), long)?.user_agent).toHaveLength(1000);
  });
});

// ─── captureAdContext ───────────────────────────────────────────────────────

describe("captureAdContext", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    calls = [];
    results = {
      tenant_conversion_settings: { data: { tenant_id: "tenant-1" } },
      classes: { data: { intakes: { slug: "sky-2026" } } },
    };
    throwOn = null;
    stallOn = null;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const logged = () =>
    JSON.stringify([...errorSpy.mock.calls, ...logSpy.mock.calls, ...warnSpy.mock.calls]);

  it("makes no database query without click data", async () => {
    await captureAdContext(args({ cookie: cookies({}) }));
    expect(calls).toHaveLength(0);
  });

  it("makes no database query when the only values are invalid", async () => {
    await captureAdContext(args({ cookie: cookies({ _fbp: "<script>" }) }));
    expect(calls).toHaveLength(0);
  });

  it("inserts nothing when the settings row is missing", async () => {
    results.tenant_conversion_settings = { data: null };
    await captureAdContext(args());
    expect(calls.some((c) => c.upsert)).toBe(false);
  });

  it("asks only for an enabled row of this tenant, so a disabled one inserts nothing", async () => {
    await captureAdContext(args());
    const settings = calls.find((c) => c.table === "tenant_conversion_settings")!;
    expect(settings.filters).toEqual([["tenant_id", "tenant-1"], ["enabled", true]]);
    results.tenant_conversion_settings = { data: null }; // what that filter returns for a disabled row
    calls = [];
    await captureAdContext(args());
    expect(calls.some((c) => c.upsert)).toBe(false);
  });

  it("inserts the right shape", async () => {
    await captureAdContext(args({ cookie: cookies({ _fbp: "fb.1.1.1", _ttp: "ttp1" }) }));
    const up = calls.find((c) => c.upsert)!;
    expect(up.table).toBe("enrollment_ad_context");
    expect(up.upsert!.row).toEqual({
      enrollment_id: "enroll-1",
      fbp: "fb.1.1.1",
      fbc: null,
      ttp: "ttp1",
      ttclid: null,
      client_ip: "203.0.113.1",
      user_agent: "UA",
      source_url: expect.stringMatching(/\/enroll\/sky-2026$/),
    });
  });

  it("never overwrites an existing row, so an idempotent replay keeps the first context", async () => {
    await captureAdContext(args());
    expect(calls.find((c) => c.upsert)!.upsert!.options).toEqual({
      onConflict: "enrollment_id",
      ignoreDuplicates: true,
    });
  });

  it("looks the slug up through classes -> intakes(slug)", async () => {
    await captureAdContext(args());
    const cls = calls.find((c) => c.table === "classes")!;
    expect(cls.select).toBe("intakes(slug)");
    expect(cls.filters).toEqual([["id", "class-1"]]);
  });

  it("builds source_url from tenantLinkOrigin plus the slug, and never includes the ref", async () => {
    await captureAdContext(args());
    const url = calls.find((c) => c.upsert)!.upsert!.row.source_url as string;
    expect(url).toBe(`${tenantLinkOrigin("skyfestival")}/enroll/sky-2026`);
    expect(url).not.toContain(ENROLLMENT_REF);
    expect(url).not.toContain("enroll-1");
    expect(url).not.toContain("?");
  });

  it("falls back to /enroll when the class has no slug", async () => {
    results.classes = { data: { intakes: null } };
    await captureAdContext(args());
    expect(calls.find((c) => c.upsert)!.upsert!.row.source_url).toMatch(/\/enroll$/);
  });

  it("falls back to /enroll without a class lookup when classId is not a string", async () => {
    await captureAdContext(args({ classId: undefined }));
    expect(calls.some((c) => c.table === "classes")).toBe(false);
    expect(calls.find((c) => c.upsert)!.upsert!.row.source_url).toMatch(/\/enroll$/);
  });

  it("does not throw when the settings read errors, and logs only the code", async () => {
    results.tenant_conversion_settings = { data: null, error: { code: "42501", message: "SECRET-VALUE" } };
    await expect(captureAdContext(args())).resolves.toBeUndefined();
    expect(calls.some((c) => c.upsert)).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logged()).toContain("42501");
    expect(logged()).not.toContain("SECRET-VALUE");
  });

  it("does not throw when the client throws, and logs no message", async () => {
    for (const table of ["tenant_conversion_settings", "classes", "enrollment_ad_context"]) {
      throwOn = table;
      await expect(captureAdContext(args())).resolves.toBeUndefined();
    }
    expect(errorSpy).toHaveBeenCalled();
    expect(logged()).not.toContain("SECRET-VALUE");
  });

  it("does not throw when the insert errors", async () => {
    results.enrollment_ad_context = { error: { code: "23503", message: "SECRET-VALUE" } };
    await expect(captureAdContext(args())).resolves.toBeUndefined();
    expect(logged()).toContain("23503");
    expect(logged()).not.toContain("SECRET-VALUE");
  });

  it("reads the click cookie as plain JSON, since Next has already decoded it", async () => {
    const plain = JSON.stringify({ fbclid: "F1", ttclid: "T1", at: 1700 });
    await captureAdContext(args({ cookie: cookies({ kn_ad_click: plain }) }));
    expect(calls.find((c) => c.upsert)!.upsert!.row).toMatchObject({ fbc: "fb.1.1700.F1", ttclid: "T1" });
  });

  describe("time limit", () => {
    const WAITING = "still waiting";
    const outcomeOf = (p: Promise<unknown>) =>
      Promise.race([
        p.then(() => "resolved"),
        new Promise((resolve) => setTimeout(() => resolve(WAITING), 2500)),
      ]);

    it("shares one 1.5-second signal across every query", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      await captureAdContext(args());

      expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(1500);
      expect(calls.map((c) => c.table)).toEqual(["tenant_conversion_settings", "classes", "enrollment_ad_context"]);
      for (const c of calls) expect(c.signal).toBe(timeoutSpy.mock.results[0].value);
    });

    it("spends no signal on a buyer with no click data", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      await captureAdContext(args({ cookie: cookies({}) }));
      expect(timeoutSpy).not.toHaveBeenCalled();
    });

    it.each(["tenant_conversion_settings", "classes", "enrollment_ad_context"])(
      "stops at the limit when %s stalls, and logs a name only",
      async (table) => {
        stallOn = table;
        const started = Date.now();

        await expect(outcomeOf(captureAdContext(args()))).resolves.toBe("resolved");

        expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
        expect(calls.filter((c) => c.upsert).length).toBe(table === "enrollment_ad_context" ? 1 : 0);
        expect(errorSpy).toHaveBeenCalledExactlyOnceWith("[conversions] ad context timed out:", "TimeoutError");
        expect(logged()).not.toContain("SECRET-VALUE");
      },
    );
  });

  it("logs no IP, cookie value or click ID on any failure path", async () => {
    const click = encodeURIComponent(JSON.stringify({ fbclid: "FBCLID-SECRET", ttclid: "TTCLID-SECRET", at: 1700 }));
    const a = args({
      cookie: cookies({ _fbp: "fb.1.FBP-SECRET.1", _ttp: "TTP-SECRET", kn_ad_click: click }),
    });
    results.tenant_conversion_settings = { data: null, error: { code: "X1", message: "203.0.113.1" } };
    await captureAdContext(a);
    results.tenant_conversion_settings = { data: { tenant_id: "tenant-1" } };
    results.classes = { data: null, error: { code: "X2", message: "FBCLID-SECRET" } };
    results.enrollment_ad_context = { error: { code: "X3", message: "TTP-SECRET" } };
    await captureAdContext(a);
    throwOn = "enrollment_ad_context";
    await captureAdContext(a);
    const out = logged();
    expect(out).toContain("X1");
    for (const secret of ["203.0.113.1", "FBP-SECRET", "TTP-SECRET", "FBCLID-SECRET", "TTCLID-SECRET"]) {
      expect(out).not.toContain(secret);
    }
  });
});
