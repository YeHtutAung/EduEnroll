import { beforeEach, describe, expect, it, vi } from "vitest";

// The repo has no DOM environment or testing-library, so hooks are replaced by
// a tiny harness: state lives in `hooks`, effects are captured and run by hand.
// That lets the test assert the first render (before effects) separately from
// the render after the effect has decided.
const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  effect: null as null | (() => void),
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
    useEffect: (fn: () => void) => {
      hooks.effect = fn;
    },
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => hooks.pathname }));
vi.mock("next/script", () => ({ default: () => null }));

import TenantTagManager from "@/components/tracking/TenantTagManager";

const GOOD = "GTM-ABC123";

function stubBrowser(opts: {
  search?: string;
  hash?: string;
  session?: string[];
  local?: string[];
  cookie?: string;
  referrer?: string;
  throwingSession?: boolean;
}) {
  const storage = (keys: string[] = []) => ({
    length: keys.length,
    key: (i: number) => keys[i] ?? null,
  });
  vi.stubGlobal("window", {
    location: { search: opts.search ?? "", hash: opts.hash ?? "", origin: "https://sky.example.com" },
    get sessionStorage() {
      if (opts.throwingSession) throw new Error("SecurityError");
      return storage(opts.session);
    },
    localStorage: storage(opts.local),
  });
  vi.stubGlobal("document", { cookie: opts.cookie ?? "", referrer: opts.referrer ?? "" });
}

type El = { props: { id?: string; strategy?: string; children?: unknown } } | null;

/** First render, run effects, render again. Returns both outputs. */
function mount(containerId: string | null, pathname: string, browser = {}) {
  hooks.state = undefined;
  hooks.effect = null;
  hooks.pathname = pathname;
  stubBrowser(browser);
  const first = TenantTagManager({ containerId }) as El;
  (hooks.effect as (() => void) | null)?.();
  const second = TenantTagManager({ containerId }) as El;
  return { first, second };
}

function renders(el: El, id = GOOD) {
  return (
    el !== null &&
    el.props.id === "tenant-gtm" &&
    el.props.strategy === "afterInteractive" &&
    String(el.props.children).includes(id)
  );
}

beforeEach(() => vi.unstubAllGlobals());

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
});
