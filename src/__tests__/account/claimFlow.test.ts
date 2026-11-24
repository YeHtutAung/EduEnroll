import { describe, it, expect } from "vitest";
import { STRIP_FRAGMENT_JS, SEAT_CLAIM_KEY, SHARE_TOKEN_PATTERN } from "@/app/(public)/t/claim/stripFragment";
import {
  afterClaim,
  decide,
  finishClaim,
  readClaimToken,
  readPreview,
  readTicketId,
  ticketHref,
} from "@/app/(public)/t/claim/claimFlow";
import { isShareToken, newShareToken } from "@/server/tickets/shareLinks";
import { isTrackedPath } from "@/lib/tagManager";
import { clickCookieToWrite, referrerCookieToWrite } from "@/components/tracking/AdClickCapture";
import { nextFromSearch } from "@/app/(public)/account/accountFlow";
import { signInHref } from "@/app/(public)/account/tickets/TicketList";

// ─── /t/claim (plan 4, Task 12) ─────────────────────────────────────────────
// The token is a secret: the inline script takes it out of the URL before any
// other script reads it, and it lives only in sessionStorage (or the
// window.__seatClaim fallback) until the claim answers.

const TOKEN = "A".repeat(20) + "b_-" + "9".repeat(20); // 43 base64url chars

function fakeStorage(opts: { throws?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => {
      if (opts.throws) throw new Error("SecurityError");
      return map.has(k) ? map.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throws) throw new Error("SecurityError");
      map.set(k, v);
    },
    removeItem: (k: string) => {
      if (opts.throws) throw new Error("SecurityError");
      map.delete(k);
    },
  };
}

interface FakeWindow {
  location: { href: string; pathname: string; hash: string };
  history: { calls: unknown[][]; replaceState: (...a: unknown[]) => void };
  sessionStorage: ReturnType<typeof fakeStorage>;
  __seatClaim?: string;
}

function fakeWindow(url: string, opts: { storageThrows?: boolean; storageGetterThrows?: boolean } = {}): FakeWindow {
  const u = new URL(url);
  const location = { href: u.href, pathname: u.pathname, hash: u.hash };
  const history = {
    calls: [] as unknown[][],
    replaceState(...a: unknown[]) {
      this.calls.push(a);
      const next = new URL(String(a[2]), location.href);
      location.href = next.href;
      location.pathname = next.pathname;
      location.hash = next.hash;
    },
  };
  const storage = fakeStorage({ throws: opts.storageThrows });
  const win = { location, history } as unknown as FakeWindow;
  Object.defineProperty(win, "sessionStorage", {
    get() {
      if (opts.storageGetterThrows) throw new Error("SecurityError");
      return storage;
    },
  });
  return win;
}

const runStrip = (win: FakeWindow) => new Function("window", STRIP_FRAGMENT_JS)(win);

describe("STRIP_FRAGMENT_JS", () => {
  it("stores a token from the fragment and takes it out of the URL", () => {
    const win = fakeWindow(`https://sky.example.com/t/claim#${TOKEN}`);
    runStrip(win);
    expect(win.sessionStorage.map.get(SEAT_CLAIM_KEY)).toBe(TOKEN);
    expect(win.history.calls).toEqual([[null, "", "/t/claim"]]);
    expect(win.location.href).toBe("https://sky.example.com/t/claim");
    expect(win.location.href).not.toContain("#");
    expect(win.__seatClaim).toBeUndefined();
  });

  it("writes nothing without a hash, and leaves the URL alone", () => {
    const win = fakeWindow("https://sky.example.com/t/claim");
    runStrip(win);
    expect(win.sessionStorage.map.size).toBe(0);
    expect(win.__seatClaim).toBeUndefined();
    expect(win.location.href).not.toContain("#");
  });

  it.each(["#short", "#" + TOKEN + "x", "#" + TOKEN.slice(1) + "=", "#" + TOKEN.slice(1) + "/"])(
    "writes nothing for a hash that isn't a token (%s), but still strips it",
    (hash) => {
      const win = fakeWindow(`https://sky.example.com/t/claim${hash}`);
      runStrip(win);
      expect(win.sessionStorage.map.size).toBe(0);
      expect(win.__seatClaim).toBeUndefined();
      expect(win.history.calls).toEqual([[null, "", "/t/claim"]]);
      expect(win.location.href).not.toContain("#");
    },
  );

  it("keeps the token on window.__seatClaim when sessionStorage throws, and still strips", () => {
    const win = fakeWindow(`https://sky.example.com/t/claim#${TOKEN}`, { storageThrows: true });
    runStrip(win);
    expect(win.__seatClaim).toBe(TOKEN);
    expect(win.location.href).not.toContain("#");
  });

  it("keeps the token on window.__seatClaim when the sessionStorage getter throws", () => {
    const win = fakeWindow(`https://sky.example.com/t/claim#${TOKEN}`, { storageGetterThrows: true });
    runStrip(win);
    expect(win.__seatClaim).toBe(TOKEN);
    expect(win.location.href).not.toContain("#");
  });

  it("accepts exactly the server's token shape", () => {
    const re = new RegExp(SHARE_TOKEN_PATTERN);
    for (const t of [TOKEN, newShareToken(), newShareToken(), "x", TOKEN + "A", TOKEN.slice(1) + "+", ""]) {
      expect(re.test(t)).toBe(isShareToken(t));
    }
  });

  it("logs nothing and sends nothing: the script has no console, fetch or beacon", () => {
    expect(STRIP_FRAGMENT_JS).not.toMatch(/console|fetch|XMLHttpRequest|sendBeacon|postMessage/);
  });
});

function storedWindow(opts: { stored?: string | null; fallback?: string; storageThrows?: boolean } = {}) {
  const storage = fakeStorage({ throws: opts.storageThrows });
  if (opts.stored) storage.map.set(SEAT_CLAIM_KEY, opts.stored);
  const win: { sessionStorage: ReturnType<typeof fakeStorage>; __seatClaim?: string } = { sessionStorage: storage };
  if (opts.fallback !== undefined) win.__seatClaim = opts.fallback;
  return win;
}

describe("claimFlow", () => {
  it("readClaimToken returns the stored token", () => {
    expect(readClaimToken(storedWindow({ stored: TOKEN }))).toBe(TOKEN);
  });

  it("readClaimToken falls back to window.__seatClaim", () => {
    expect(readClaimToken(storedWindow({ fallback: TOKEN }))).toBe(TOKEN);
    expect(readClaimToken(storedWindow({ fallback: TOKEN, storageThrows: true }))).toBe(TOKEN);
  });

  it("readClaimToken returns null with nothing stored, or something that isn't a token", () => {
    expect(readClaimToken(storedWindow())).toBeNull();
    expect(readClaimToken(storedWindow({ stored: "nope" }))).toBeNull();
    expect(readClaimToken(storedWindow({ storageThrows: true }))).toBeNull();
    expect(readClaimToken(null)).toBeNull();
  });

  it("finishClaim removes the token from both places", () => {
    const win = storedWindow({ stored: TOKEN, fallback: TOKEN });
    finishClaim(win);
    expect(win.sessionStorage.map.has(SEAT_CLAIM_KEY)).toBe(false);
    expect(win.__seatClaim).toBeUndefined();
    expect(readClaimToken(win)).toBeNull();
  });

  it("finishClaim still clears the fallback when sessionStorage throws", () => {
    const win = storedWindow({ fallback: TOKEN, storageThrows: true });
    finishClaim(win);
    expect(win.__seatClaim).toBeUndefined();
  });

  it.each([
    [200, "ready"],
    [401, "signIn"],
    [404, "gone"],
    [429, "limited"],
    [403, "error"],
    [413, "error"],
    [500, "error"],
    [503, "error"],
  ] as const)("decide(%i) is %s", (status, want) => {
    expect(decide(status)).toBe(want);
  });

  it("afterClaim: the token is gone, so no state offers a retry", () => {
    expect(afterClaim(404)).toEqual({ kind: "gone" });
    expect(afterClaim(429)).toEqual({ kind: "limited", canRetry: false });
    expect(afterClaim(401)).toEqual({ kind: "error", canRetry: false });
    expect(afterClaim(503)).toEqual({ kind: "error", canRetry: false });
  });

  it("readPreview takes the preview route's 200 body, and nothing malformed", () => {
    expect(readPreview({ eventName: "Sky", tier: "VIP", seatNo: 2, eventDate: "2026-12-20" })).toEqual({
      eventName: "Sky",
      tier: "VIP",
      seatNo: 2,
      eventDate: "2026-12-20",
    });
    expect(readPreview({ eventName: "Sky", tier: "VIP", seatNo: 2, eventDate: null })?.eventDate).toBeNull();
    expect(readPreview({ tier: "VIP" })).toBeNull();
    expect(readPreview(null)).toBeNull();
    expect(readPreview("x")).toBeNull();
  });

  it("readTicketId and ticketHref", () => {
    expect(readTicketId({ ticketId: "t-1" })).toBe("t-1");
    expect(readTicketId({})).toBeNull();
    expect(readTicketId(null)).toBeNull();
    expect(ticketHref("a/b")).toBe("/account/tickets/a%2Fb");
  });
});

describe("sign-in round trip", () => {
  it("/account accepts /t/claim as its next", () => {
    expect(signInHref("/t/claim")).toBe("/account?next=%2Ft%2Fclaim");
    expect(nextFromSearch("?next=%2Ft%2Fclaim")).toBe("/t/claim");
  });
});

// Decision 10: no tag script runs on /t/claim. TenantTagManager's render is
// pinned in src/__tests__/tracking/tenantTagManager.test.tsx.
describe("no tags on /t/claim", () => {
  it("isTrackedPath is false", () => {
    expect(isTrackedPath("/t/claim")).toBe(false);
    expect(isTrackedPath("/t/claim/")).toBe(false);
  });

  it("AdClickCapture writes no cookie there", () => {
    const base = { containerId: "GTM-ABC1234", pathname: "/t/claim", search: "?fbclid=F1", existing: null, now: 5 };
    expect(clickCookieToWrite(base)).toBeNull();
    expect(
      referrerCookieToWrite({
        containerId: "GTM-ABC1234",
        pathname: "/t/claim",
        search: "",
        referrer: "https://l.facebook.com/",
        origin: "https://sky.example.com",
      }),
    ).toBeNull();
  });
});
