import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GTM_CONTAINER_ID_RE,
  normalizeGtmContainerId,
  isTrackedPath,
  gtmAllowedOnHost,
  SENSITIVE_PARAMS,
  SAFE_STORAGE_KEYS,
  isBrowserStateClean,
  pushDataLayer,
  hardNavigate,
  decideGtmForDocument,
  resetGtmDocumentLatchForTests,
  initialDocumentUrl,
  reloadIfRestoredFromCache,
  claimNavigation,
} from "@/lib/tagManager";

describe("normalizeGtmContainerId", () => {
  it("trims and uppercases", () => {
    expect(normalizeGtmContainerId("  gtm-abc123 ")).toBe("GTM-ABC123");
  });
  it("maps blank and null to null", () => {
    expect(normalizeGtmContainerId("")).toBeNull();
    expect(normalizeGtmContainerId("   ")).toBeNull();
    expect(normalizeGtmContainerId(null)).toBeNull();
    expect(normalizeGtmContainerId(undefined)).toBeNull();
  });
  it("flags malformed values", () => {
    expect(normalizeGtmContainerId("GTM-")).toBe("invalid");
    expect(normalizeGtmContainerId("GTM-AB")).toBe("invalid");
    expect(normalizeGtmContainerId("GTM-ABCDEFGHIJKLM")).toBe("invalid");
    expect(normalizeGtmContainerId("UA-123456")).toBe("invalid");
    expect(normalizeGtmContainerId("GTM-AB');alert(1)//")).toBe("invalid");
    expect(normalizeGtmContainerId(123)).toBe("invalid");
  });
  it("regex accepts 4 to 12 chars", () => {
    expect(GTM_CONTAINER_ID_RE.test("GTM-ABCD")).toBe(true);
    expect(GTM_CONTAINER_ID_RE.test("GTM-ABCDEFGHIJ12")).toBe(true);
    expect(GTM_CONTAINER_ID_RE.test("GTM-abcd")).toBe(false);
  });
});

describe("isTrackedPath", () => {
  it.each([
    "/enroll",
    "/enroll/",
    "/enroll/sky-fest-2026",
    "/enroll/sky-fest-2026/",
    "/enroll/sky-fest-2026/tickets",
    "/enroll/sky-fest-2026/tickets/",
  ])("tracks %s", (p) => expect(isTrackedPath(p)).toBe(true));

  it.each([
    "/enroll/form",
    "/enroll/form/",
    "/enroll/payment",
    "/enroll/payment/X",
    "/enroll/x/checkout",
    "/enroll/x/checkout/",
    "/enroll/x/checkout/success",
    "/enroll/x/checkout/payment",
    "/enroll/x/checkout/new",
    "/enroll/x/status",
    "/enroll/x/interest",
    "/status",
    "/",
    "/admin",
    "/enroll/x/tickets/extra",
    "/enroll/%66orm",
    "/enroll/x/%74ickets",
  ])("does not track %s", (p) => expect(isTrackedPath(p)).toBe(false));
});

describe("gtmAllowedOnHost", () => {
  const saved = process.env.TENANT_CUSTOM_DOMAINS;
  beforeEach(() => {
    process.env.TENANT_CUSTOM_DOMAINS = JSON.stringify({ "tickets.skyfest.com": "skyfestival" });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TENANT_CUSTOM_DOMAINS;
    else process.env.TENANT_CUSTOM_DOMAINS = saved;
  });

  const allowed = (host: string, tenantSlug: string, isProduction: boolean, allowNonProduction: boolean) =>
    gtmAllowedOnHost({ host, tenantSlug, isProduction, allowNonProduction });

  it("production: custom domain of the tenant is allowed", () => {
    expect(allowed("tickets.skyfest.com", "skyfestival", true, false)).toBe(true);
  });
  it("production: the tenant subdomain is not allowed", () => {
    expect(allowed("skyfestival.kuunyi.com", "skyfestival", true, false)).toBe(false);
  });
  it("production: another tenant's custom domain is not allowed", () => {
    expect(allowed("tickets.skyfest.com", "other", true, false)).toBe(false);
  });
  it("production: the non-production opt-in changes nothing", () => {
    expect(allowed("skyfestival.kuunyi.com", "skyfestival", true, true)).toBe(false);
    expect(allowed("tickets.skyfest.com", "skyfestival", true, true)).toBe(true);
  });
  it("non-production: off by default, on any host", () => {
    expect(allowed("skyfestival.kuunyi.com", "skyfestival", false, false)).toBe(false);
    expect(allowed("tickets.skyfest.com", "skyfestival", false, false)).toBe(false);
    expect(allowed("my-branch.vercel.app", "skyfestival", false, false)).toBe(false);
  });
  it("non-production: any host with the explicit opt-in", () => {
    expect(allowed("skyfestival.kuunyi.com", "skyfestival", false, true)).toBe(true);
    expect(allowed("tickets.skyfest.com", "skyfestival", false, true)).toBe(true);
  });
  it("the public layout passes the opt-in only for the exact string \"true\"", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(public)/layout.tsx"), "utf8");
    expect(src).toMatch(/allowNonProduction:\s*process\.env\.GTM_ALLOW_NON_PRODUCTION\s*===\s*"true"/);
  });
  it(".env.local.example documents the opt-in, off", () => {
    const src = readFileSync(join(process.cwd(), ".env.local.example"), "utf8");
    expect(src).toMatch(/^GTM_ALLOW_NON_PRODUCTION=\s*$/m);
  });
});

type TestStore = { readonly length: number; key(i: number): string | null };
function store(entries: Record<string, string> = {}): TestStore {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (i: number) => keys[i] ?? null,
  };
}

type Input = Parameters<typeof isBrowserStateClean>[0];
const ORIGIN = "https://sky.example.com";

// Tests pass storages as plain objects; state() wraps them in the getters the
// real signature wants, and fills in origin and referrer.
function state(
  over: {
    location?: { search: string; hash: string };
    sessionStorage?: TestStore;
    localStorage?: TestStore;
    cookie?: string;
    referrer?: string;
    initialUrl?: string | undefined;
  } = {},
): Input {
  const ss = over.sessionStorage ?? store();
  const ls = over.localStorage ?? store();
  return {
    location: { search: "", hash: "", ...over.location, origin: ORIGIN },
    sessionStorage: () => ss,
    localStorage: () => ls,
    cookie: over.cookie ?? "",
    referrer: over.referrer ?? "",
    initialUrl: "initialUrl" in over ? over.initialUrl : `${ORIGIN}/enroll/x`,
  };
}

describe("isBrowserStateClean", () => {
  it("is clean with nothing set", () => {
    expect(isBrowserStateClean(state())).toBe(true);
  });

  it.each(SENSITIVE_PARAMS)("blocks on ?%s=", (p) => {
    expect(isBrowserStateClean(state({ location: { search: `?${p}=abc`, hash: "" } }))).toBe(false);
  });

  it.each(["fbclid", "ttclid", "utm_source"])("does not treat %s as sensitive", (p) => {
    expect(isBrowserStateClean(state({ location: { search: `?${p}=abc`, hash: "" } }))).toBe(true);
  });

  it("blocks on pa= in the hash", () => {
    expect(isBrowserStateClean(state({ location: { search: "", hash: "#pa=tok" } }))).toBe(false);
    expect(isBrowserStateClean(state({ location: { search: "", hash: "#x=1&pa=tok" } }))).toBe(false);
  });

  it("does not block on an unrelated hash", () => {
    expect(isBrowserStateClean(state({ location: { search: "", hash: "#section" } }))).toBe(true);
  });

  it("cart_123 alone passes", () => {
    expect(isBrowserStateClean(state({ sessionStorage: store({ cart_123: "[]" }) }))).toBe(true);
  });

  it.each(["cs_ABC", "pa_x", "ck_x", "something_unknown", "cart_", "cart_12a", "xcart_1"])(
    "session key %s blocks",
    (k) => {
      expect(isBrowserStateClean(state({ sessionStorage: store({ [k]: "v" }) }))).toBe(false);
    },
  );

  it("an unknown localStorage key blocks", () => {
    expect(isBrowserStateClean(state({ localStorage: store({ whatever: "v" }) }))).toBe(false);
  });

  it("a safe key does not hide an unsafe one", () => {
    expect(
      isBrowserStateClean(state({ sessionStorage: store({ cart_1: "[]", cs_ABC: "secret" }) })),
    ).toBe(false);
  });

  it("an sb-...-auth-token cookie blocks", () => {
    expect(
      isBrowserStateClean(state({ cookie: "a=1; sb-abcdef-auth-token=xyz; b=2" })),
    ).toBe(false);
    expect(isBrowserStateClean(state({ cookie: "sb-abcdef-auth-token=xyz" }))).toBe(false);
  });

  it("unrelated cookies pass", () => {
    expect(isBrowserStateClean(state({ cookie: "_ga=1; theme=dark" }))).toBe(true);
  });

  it("a storage that throws blocks GTM", () => {
    const throwing = {
      get length(): number {
        throw new Error("denied");
      },
      key: () => null,
    };
    expect(isBrowserStateClean(state({ sessionStorage: throwing }))).toBe(false);
    expect(isBrowserStateClean(state({ localStorage: throwing }))).toBe(false);
  });

  it("a storage getter that throws blocks GTM", () => {
    const base = state();
    const boom = () => {
      throw new Error("SecurityError");
    };
    expect(isBrowserStateClean({ ...base, sessionStorage: boom })).toBe(false);
    expect(isBrowserStateClean({ ...base, localStorage: boom })).toBe(false);
  });

  it("matches sensitive query params case-insensitively", () => {
    expect(isBrowserStateClean(state({ location: { search: "?REF=1", hash: "" } }))).toBe(false);
    expect(isBrowserStateClean(state({ location: { search: "?Payment_Intent=1", hash: "" } }))).toBe(false);
  });

  it("checks the whole sensitive list in the hash", () => {
    expect(isBrowserStateClean(state({ location: { search: "", hash: "#ref=1" } }))).toBe(false);
    expect(isBrowserStateClean(state({ location: { search: "", hash: "#PSID=1" } }))).toBe(false);
    expect(isBrowserStateClean(state({ location: { search: "", hash: "#session_id=1" } }))).toBe(false);
  });

  it("an sb-x-auth-token.0 cookie blocks", () => {
    expect(isBrowserStateClean(state({ cookie: "sb-x-auth-token.0=abc" }))).toBe(false);
  });

  describe("referrer", () => {
    const ref = (r: string) => isBrowserStateClean(state({ referrer: r }));
    it("blocks a same-origin payment page", () => {
      expect(ref(`${ORIGIN}/enroll/payment/X`)).toBe(false);
    });
    it("blocks a same-origin checkout URL carrying a ref", () => {
      expect(ref(`${ORIGIN}/enroll/x/checkout?ref=A`)).toBe(false);
    });
    it("blocks a tracked path whose query has a sensitive param", () => {
      expect(ref(`${ORIGIN}/enroll/x?psid=1`)).toBe(false);
      expect(ref(`${ORIGIN}/enroll/x#ref=1`)).toBe(false);
    });
    it("allows a same-origin tracked page", () => {
      expect(ref(`${ORIGIN}/enroll/x`)).toBe(true);
      expect(ref(`${ORIGIN}/enroll/x/tickets?fbclid=1`)).toBe(true);
    });
    it("allows an empty referrer", () => {
      expect(ref("")).toBe(true);
    });
    it("allows a cross-origin referrer", () => {
      expect(ref("https://facebook.com/l.php?u=abc")).toBe(true);
    });
    it("blocks a malformed referrer", () => {
      expect(ref("not a url")).toBe(false);
    });
  });

  describe("initial document URL", () => {
    const init = (u: string | undefined) => isBrowserStateClean(state({ initialUrl: u }));
    it("allows a same-origin tracked URL", () => {
      expect(init(`${ORIGIN}/enroll`)).toBe(true);
      expect(init(`${ORIGIN}/enroll/x/tickets/?fbclid=1`)).toBe(true);
    });
    it("blocks when unavailable", () => {
      expect(init(undefined)).toBe(false);
      expect(init("")).toBe(false);
    });
    it("blocks when malformed", () => {
      expect(init("not a url")).toBe(false);
    });
    it("blocks another origin", () => {
      expect(init("https://other.example.com/enroll/x")).toBe(false);
    });
    it("blocks an untracked path", () => {
      expect(init(`${ORIGIN}/enroll/x/checkout/new`)).toBe(false);
      expect(init(`${ORIGIN}/enroll/form`)).toBe(false);
    });
    it("blocks a sensitive query or hash param", () => {
      expect(init(`${ORIGIN}/enroll/x?psid=1`)).toBe(false);
      expect(init(`${ORIGIN}/enroll/x?Cart_Key=1`)).toBe(false);
      expect(init(`${ORIGIN}/enroll/x#pa=tok`)).toBe(false);
      expect(init(`${ORIGIN}/enroll/x#ref=1`)).toBe(false);
    });
  });

  it("SAFE_STORAGE_KEYS allows only cart_<digits>", () => {
    expect(SAFE_STORAGE_KEYS.some((re) => re.test("cart_1730000000000"))).toBe(true);
    expect(SAFE_STORAGE_KEYS.some((re) => re.test("ck_cart_1730000000000"))).toBe(false);
  });
});

describe("pushDataLayer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates dataLayer when absent and keeps the events", () => {
    const win: Record<string, unknown> = {};
    vi.stubGlobal("window", win);
    pushDataLayer("view_item", { currency: "MMK" });
    pushDataLayer("begin_checkout", { value: 5 });
    expect(win.dataLayer).toEqual([
      { ecommerce: null },
      { event: "view_item", ecommerce: { currency: "MMK" } },
      { ecommerce: null },
      { event: "begin_checkout", ecommerce: { value: 5 } },
    ]);
  });

  it("appends to an existing dataLayer", () => {
    const existing = [{ a: 1 }];
    const win: Record<string, unknown> = { dataLayer: existing };
    vi.stubGlobal("window", win);
    pushDataLayer("view_item", {});
    expect(win.dataLayer).toBe(existing);
    expect(existing).toHaveLength(3);
  });
});

describe("next.config trailingSlash", () => {
  // The Referrer-Policy sources below are written without a trailing slash;
  // turning trailingSlash on would change which paths they match.
  it("is not set", async () => {
    const cfg = (await import("../../../next.config.mjs")).default as Record<string, unknown>;
    expect("trailingSlash" in cfg).toBe(false);
  });
});

describe("next.config Referrer-Policy", () => {
  it("untracked public routes send strict-origin, after the global entry", async () => {
    const cfg = (await import("../../../next.config.mjs")).default as {
      headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
    };
    const rules = await cfg.headers();
    const policy = (r: { headers: { key: string; value: string }[] }) =>
      r.headers.find((h) => h.key === "Referrer-Policy")?.value;
    const globalIdx = rules.findIndex((r) => r.source === "/:path*");
    expect(globalIdx).toBe(0);
    expect(policy(rules[0])).toBe("strict-origin-when-cross-origin");
    const sources = [
      "/enroll/payment/:path*",
      "/enroll/:slug/checkout/:path*",
      "/enroll/:slug/status",
      "/enroll/:slug/success",
      "/enroll/:slug/interest",
      "/enroll/form",
      "/status",
    ];
    for (const src of sources) {
      const i = rules.findIndex((r) => r.source === src);
      expect(i, src).toBeGreaterThan(globalIdx);
      expect(policy(rules[i]), src).toBe("strict-origin");
    }
  });
});

describe("hardNavigate", () => {
  let assign: ReturnType<typeof vi.fn>;
  let win: Record<string, unknown>;

  beforeEach(() => {
    vi.useFakeTimers();
    assign = vi.fn();
    win = { location: { assign } };
    vi.stubGlobal("window", win);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("navigates at once without afterEvent", () => {
    hardNavigate("/x");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/x");
  });

  it("navigates at once when GTM is absent, still queuing the event", () => {
    hardNavigate("/x", { afterEvent: { name: "begin_checkout", payload: { value: 1 } } });
    expect(assign).toHaveBeenCalledTimes(1);
    expect((win.dataLayer as unknown[]).length).toBeGreaterThan(0);
  });

  it("with GTM present, waits for eventCallback and navigates once", () => {
    win.google_tag_manager = {};
    hardNavigate("/x", { afterEvent: { name: "begin_checkout", payload: {} } });
    expect(assign).not.toHaveBeenCalled();
    const evt = (win.dataLayer as Record<string, unknown>[]).find((e) => e.event === "begin_checkout")!;
    (evt.eventCallback as () => void)();
    expect(assign).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("with GTM present, falls back after 300 ms and navigates once", () => {
    win.google_tag_manager = {};
    hardNavigate("/x", { afterEvent: { name: "begin_checkout", payload: {} } });
    vi.advanceTimersByTime(299);
    expect(assign).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(assign).toHaveBeenCalledTimes(1);
    const evt = (win.dataLayer as Record<string, unknown>[]).find((e) => e.event === "begin_checkout")!;
    (evt.eventCallback as () => void)();
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe("initialDocumentUrl", () => {
  it("reads the first navigation entry's name", () => {
    const perf = { getEntriesByType: (t: string) => (t === "navigation" ? [{ name: "https://a/enroll" }] : []) };
    expect(initialDocumentUrl(perf)).toBe("https://a/enroll");
  });
  it("is undefined without an entry, without the API, or when it throws", () => {
    expect(initialDocumentUrl({ getEntriesByType: () => [] })).toBeUndefined();
    expect(initialDocumentUrl(undefined)).toBeUndefined();
    expect(
      initialDocumentUrl({
        getEntriesByType: () => {
          throw new Error("x");
        },
      }),
    ).toBeUndefined();
  });
});

describe("decideGtmForDocument (per-document latch)", () => {
  beforeEach(() => resetGtmDocumentLatchForTests());

  it("a clean first evaluation enables GTM, and later clean ones keep it", () => {
    expect(decideGtmForDocument(true)).toBe(true);
    expect(decideGtmForDocument(true)).toBe(true);
  });

  it("a dirty first evaluation keeps GTM off even if later ones are clean", () => {
    expect(decideGtmForDocument(false)).toBe(false);
    expect(decideGtmForDocument(true)).toBe(false);
    expect(decideGtmForDocument(true)).toBe(false);
  });

  it("a dirty later evaluation turns it off for the rest of the document", () => {
    expect(decideGtmForDocument(true)).toBe(true);
    expect(decideGtmForDocument(false)).toBe(false);
    expect(decideGtmForDocument(true)).toBe(false);
  });

  it("the reset starts a fresh document", () => {
    decideGtmForDocument(false);
    resetGtmDocumentLatchForTests();
    expect(decideGtmForDocument(true)).toBe(true);
  });
});

describe("reloadIfRestoredFromCache", () => {
  beforeEach(() => resetGtmDocumentLatchForTests());

  it("reloads on a restore when GTM started in this document (latch on)", () => {
    decideGtmForDocument(true);
    const reload = vi.fn();
    reloadIfRestoredFromCache({ persisted: true }, reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("does not reload on a restore when the latch is off", () => {
    decideGtmForDocument(false);
    const reload = vi.fn();
    reloadIfRestoredFromCache({ persisted: true }, reload);
    expect(reload).not.toHaveBeenCalled();
  });
  it("does not reload on a restore when the latch was never set", () => {
    const reload = vi.fn();
    reloadIfRestoredFromCache({ persisted: true }, reload);
    expect(reload).not.toHaveBeenCalled();
  });
  it("still reloads when GTM started and a later evaluation turned the latch off", () => {
    // The container cannot be unloaded, so "started" outlives the latch.
    decideGtmForDocument(true);
    decideGtmForDocument(false);
    const reload = vi.fn();
    reloadIfRestoredFromCache({ persisted: true }, reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("does nothing on a normal page show, even with the latch on", () => {
    decideGtmForDocument(true);
    const reload = vi.fn();
    reloadIfRestoredFromCache({ persisted: false }, reload);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("claimNavigation", () => {
  it("lets the first caller through and blocks the rest", () => {
    const ref = { current: false };
    expect(claimNavigation(ref)).toBe(true);
    expect(claimNavigation(ref)).toBe(false);
    expect(claimNavigation(ref)).toBe(false);
    expect(ref.current).toBe(true);
  });
});
