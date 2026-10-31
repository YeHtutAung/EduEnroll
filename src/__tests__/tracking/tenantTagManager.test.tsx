import { beforeEach, describe, expect, it, vi } from "vitest";

// The repo has no DOM environment or testing-library, so hooks are replaced by
// a tiny harness: state lives in `hooks`, effects are captured and run by hand.
// That lets the test assert the first render (before effects) separately from
// the render after the effect has decided.
const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  effects: [] as (() => void | (() => void))[],
  pathname: "/enroll",
}));

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (hooks.state === undefined) hooks.state = init;
      return [
        hooks.state,
        (v: unknown) => {
          hooks.state = v;
        },
      ];
    },
    useEffect: (fn: () => void | (() => void)) => {
      hooks.effects.push(fn);
    },
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => hooks.pathname }));
vi.mock("next/script", () => ({ default: () => null }));

import TenantTagManager from "@/components/tracking/TenantTagManager";
import { resetGtmDocumentLatchForTests } from "@/lib/tagManager";

const GOOD = "GTM-ABC123";

const ORIGIN = "https://sky.example.com";

interface Browser {
  search?: string;
  hash?: string;
  session?: string[];
  local?: string[];
  cookie?: string;
  referrer?: string;
  throwingSession?: boolean;
  /** Initial document URL (navigation entry name). null = no entry. */
  initialUrl?: string | null;
}

const listeners = new Map<string, Set<(e: unknown) => void>>();
const reload = vi.fn();

function stubBrowser(opts: Browser, pathname: string) {
  const storage = (keys: string[] = []) => ({
    length: keys.length,
    key: (i: number) => keys[i] ?? null,
  });
  const initialUrl =
    opts.initialUrl === null ? undefined : (opts.initialUrl ?? `${ORIGIN}${pathname}${opts.search ?? ""}`);
  vi.stubGlobal("window", {
    location: { search: opts.search ?? "", hash: opts.hash ?? "", origin: ORIGIN, reload },
    get sessionStorage() {
      if (opts.throwingSession) throw new Error("SecurityError");
      return storage(opts.session);
    },
    localStorage: storage(opts.local),
    performance: {
      getEntriesByType: (t: string) => (t === "navigation" && initialUrl ? [{ name: initialUrl }] : []),
    },
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(fn);
    },
    removeEventListener: (t: string, fn: (e: unknown) => void) => {
      listeners.get(t)?.delete(fn);
    },
  });
  vi.stubGlobal("document", { cookie: opts.cookie ?? "", referrer: opts.referrer ?? "" });
}

type El = { props: { id?: string; strategy?: string; children?: unknown } } | null;

let cleanups: (() => void)[] = [];

function runEffects() {
  const fx = hooks.effects;
  hooks.effects = [];
  for (const fn of fx) {
    const c = fn();
    if (typeof c === "function") cleanups.push(c);
  }
}

/** First render, run effects, render again. Returns both outputs. A fresh document. */
function mount(containerId: string | null, pathname: string, browser: Browser = {}) {
  resetGtmDocumentLatchForTests();
  hooks.state = undefined;
  hooks.effects = [];
  hooks.pathname = pathname;
  stubBrowser(browser, pathname);
  const first = TenantTagManager({ containerId }) as El;
  runEffects();
  const second = TenantTagManager({ containerId }) as El;
  hooks.effects = [];
  return { first, second };
}

/**
 * A soft navigation in the same document: new pathname and browser state, the
 * effects run again, render. The latch is NOT reset. Pass the document's
 * original initialUrl, which a soft navigation does not change.
 */
function softNavigate(containerId: string | null, pathname: string, browser: Browser = {}) {
  hooks.pathname = pathname;
  stubBrowser(browser, pathname);
  TenantTagManager({ containerId });
  runEffects();
  const out = TenantTagManager({ containerId }) as El;
  hooks.effects = [];
  return out;
}

function renders(el: El, id = GOOD) {
  return (
    el !== null &&
    el.props.id === "tenant-gtm" &&
    el.props.strategy === "afterInteractive" &&
    String(el.props.children).includes(id)
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  listeners.clear();
  reload.mockReset();
  cleanups = [];
});

describe("TenantTagManager", () => {
  it("renders nothing on the first render, before effects run", () => {
    const { first, second } = mount(GOOD, "/enroll/sky-fest-2026");
    expect(first).toBeNull();
    expect(renders(second)).toBe(true);
  });

  it.each(["/enroll", "/enroll/sky-fest-2026", "/enroll/sky-fest-2026/tickets"])(
    "renders the script on %s",
    (path) => {
      expect(renders(mount(GOOD, path).second)).toBe(true);
    },
  );

  it.each([
    "/enroll/form",
    "/enroll/payment/X",
    "/enroll/x/checkout",
    "/enroll/x/checkout/success",
    "/enroll/x/status",
    "/enroll/x/interest",
    "/status",
  ])("renders nothing on %s", (path) => {
    expect(mount(GOOD, path).second).toBeNull();
  });

  it.each([null, "", "gtm-abc123", "GTM-AB", "GTM-ABC123');alert(1);('"])(
    "renders nothing with container id %j",
    (id) => {
      expect(mount(id, "/enroll").second).toBeNull();
    },
  );

  it("renders nothing with ?psid=", () => {
    expect(mount(GOOD, "/enroll/x", { search: "?psid=123" }).second).toBeNull();
  });

  it("renders nothing with #pa=", () => {
    expect(mount(GOOD, "/enroll/x", { hash: "#pa=tok" }).second).toBeNull();
  });

  it("renders nothing with a pa_ storage key", () => {
    expect(mount(GOOD, "/enroll/x", { session: ["pa_x"] }).second).toBeNull();
  });

  it("renders nothing with a cs_ storage key", () => {
    expect(mount(GOOD, "/enroll/x", { session: ["cs_x"] }).second).toBeNull();
  });

  it("renders nothing with an sb- cookie", () => {
    expect(mount(GOOD, "/enroll/x", { cookie: "sb-abc-auth-token=1" }).second).toBeNull();
  });

  it.each([
    ["same-origin payment", "https://sky.example.com/enroll/payment/X", false],
    ["same-origin checkout with ref", "https://sky.example.com/enroll/x/checkout?ref=A", false],
    ["malformed", "not a url", false],
    ["same-origin event page", "https://sky.example.com/enroll/x", true],
    ["cross-origin", "https://facebook.com/l.php?u=1", true],
  ])("referrer: %s", (_n, referrer, ok) => {
    expect(renders(mount(GOOD, "/enroll/x", { referrer }).second)).toBe(ok);
  });

  it("renders nothing when reading sessionStorage throws", () => {
    expect(mount(GOOD, "/enroll/x", { throwingSession: true }).second).toBeNull();
  });

  it("renders nothing with ?REF=", () => {
    expect(mount(GOOD, "/enroll/x", { search: "?REF=1" }).second).toBeNull();
  });

  it("renders with ?fbclid=", () => {
    expect(renders(mount(GOOD, "/enroll/x", { search: "?fbclid=abc" }).second)).toBe(true);
  });

  it("renders nothing when the initial document URL is unavailable", () => {
    expect(mount(GOOD, "/enroll/x", { initialUrl: null }).second).toBeNull();
  });

  it("renders nothing when the document started on an untracked URL", () => {
    expect(mount(GOOD, "/enroll/x", { initialUrl: `${ORIGIN}/enroll/x/checkout/new?cart_key=1` }).second).toBeNull();
  });

  it("renders nothing when the document started with a sensitive param", () => {
    expect(mount(GOOD, "/enroll/x", { initialUrl: `${ORIGIN}/enroll/x?psid=9` }).second).toBeNull();
  });

  describe("per-document latch", () => {
    it("a dirty first evaluation keeps GTM off after a clean-looking soft navigation", () => {
      // Even with every input looking clean on the second evaluation.
      expect(mount(GOOD, "/enroll/x/checkout/new").second).toBeNull();
      expect(softNavigate(GOOD, "/enroll/x/tickets", { initialUrl: `${ORIGIN}/enroll/x/tickets` })).toBeNull();
    });

    it("once enabled, a soft navigation between tracked pages keeps the script", () => {
      expect(renders(mount(GOOD, "/enroll/x").second)).toBe(true);
      expect(renders(softNavigate(GOOD, "/enroll/x/tickets", { initialUrl: `${ORIGIN}/enroll/x` }))).toBe(true);
    });

    it("once enabled, a dirty evaluation stops rendering for the rest of the document", () => {
      expect(renders(mount(GOOD, "/enroll/x").second)).toBe(true);
      expect(softNavigate(GOOD, "/enroll/x/tickets", { initialUrl: `${ORIGIN}/enroll/x`, session: ["ck_1"] })).toBeNull();
      expect(softNavigate(GOOD, "/enroll/x", { initialUrl: `${ORIGIN}/enroll/x` })).toBeNull();
    });
  });

  describe("back/forward cache restore", () => {
    it("reloads when the page is restored from the cache", () => {
      mount(GOOD, "/enroll/x");
      const fns = Array.from(listeners.get("pageshow") ?? []);
      expect(fns).toHaveLength(1);
      fns[0]({ persisted: false });
      expect(reload).not.toHaveBeenCalled();
      fns[0]({ persisted: true });
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("removes the listener on unmount", () => {
      mount(GOOD, "/enroll/x");
      expect(listeners.get("pageshow")?.size).toBe(1);
      for (const c of cleanups) c();
      expect(listeners.get("pageshow")?.size ?? 0).toBe(0);
    });

    it("adds no listener when the tenant has no container", () => {
      mount(null, "/enroll/x");
      expect(listeners.get("pageshow")?.size ?? 0).toBe(0);
    });
  });
});
