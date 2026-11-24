import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  shareTargets,
  isPhoneUserAgent,
  canShareSheet,
  shareSheet,
} from "@/app/(public)/account/tickets/[id]/shareTargets";

// ─── "Share to app" links for a seat-share URL ──────────────────────────────

const URL_SECRET = "https://skyfestival.example.test/t/claim#AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const MESSAGE = "I'm sharing a seat for Sky Festival & Friends with you. Open this link to claim it:";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shareTargets", () => {
  const t = shareTargets(URL_SECRET, MESSAGE);

  it("Telegram: t.me/share/url with the url and text encoded", () => {
    const u = new URL(t.telegram);
    expect(u.origin + u.pathname).toBe("https://t.me/share/url");
    expect(u.searchParams.get("url")).toBe(URL_SECRET);
    expect(u.searchParams.get("text")).toBe(MESSAGE);
    // The fragment is encoded, so the secret stays inside the shared text.
    expect(t.telegram).toContain("%23AbCdEf");
    expect(u.hash).toBe("");
  });

  it("Viber: viber://forward with the message, a space, then the url", () => {
    expect(t.viber.startsWith("viber://forward?text=")).toBe(true);
    const encoded = t.viber.slice("viber://forward?text=".length);
    expect(encoded).not.toContain("#");
    expect(encoded).toContain("%23AbCdEf");
    expect(decodeURIComponent(encoded)).toBe(`${MESSAGE} ${URL_SECRET}`);
  });

  it("Messenger: fb-messenger://share with the link encoded", () => {
    expect(t.messenger.startsWith("fb-messenger://share?link=")).toBe(true);
    const encoded = t.messenger.slice("fb-messenger://share?link=".length);
    expect(encoded).not.toContain("#");
    expect(encoded).toContain("%23AbCdEf");
    expect(decodeURIComponent(encoded)).toBe(URL_SECRET);
  });

  it("no raw # anywhere: the secret never becomes the href's own fragment", () => {
    for (const href of [t.telegram, t.viber, t.messenger]) expect(href).not.toContain("#");
  });
});

describe("isPhoneUserAgent", () => {
  it.each([
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15",
  ])("a phone: %s", (ua) => {
    expect(isPhoneUserAgent(ua)).toBe(true);
  });

  it.each([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "",
  ])("not a phone: %s", (ua) => {
    expect(isPhoneUserAgent(ua)).toBe(false);
  });
});

describe("the share sheet", () => {
  it("available only when navigator.share is a function", () => {
    expect(canShareSheet(undefined)).toBe(false);
    expect(canShareSheet({} as Navigator)).toBe(false);
    expect(canShareSheet({ share: "nope" } as unknown as Navigator)).toBe(false);
    expect(canShareSheet({ share: vi.fn() } as unknown as Navigator)).toBe(true);
  });

  it("calls navigator.share with the url and the text", async () => {
    const share = vi.fn(async () => {});
    const outcome = await shareSheet({ share } as unknown as Navigator, URL_SECRET, MESSAGE);
    expect(share).toHaveBeenCalledWith({ text: MESSAGE, url: URL_SECRET });
    expect(outcome).toBe("shared");
  });

  it("the user cancelling the sheet (AbortError) is silent", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(shareSheet({ share } as unknown as Navigator, URL_SECRET, MESSAGE)).resolves.toBe("cancelled");
  });

  it("any other failure doesn't throw; Copy stays the fallback", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    await expect(shareSheet({ share } as unknown as Navigator, URL_SECRET, MESSAGE)).resolves.toBe("failed");
  });

  it("no share function: nothing happens", async () => {
    await expect(shareSheet({} as Navigator, URL_SECRET, MESSAGE)).resolves.toBe("failed");
  });

  it("sharing writes nothing to storage and logs nothing", async () => {
    const local = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    const session = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const share = vi.fn(async () => {});
    await shareSheet({ share } as unknown as Navigator, URL_SECRET, MESSAGE);
    await shareSheet(
      {
        share: async () => {
          throw new Error("boom");
        },
      } as unknown as Navigator,
      URL_SECRET,
      MESSAGE,
    );
    for (const s of [local, session]) {
      expect(s.setItem).not.toHaveBeenCalled();
      expect(s.getItem).not.toHaveBeenCalled();
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });

  it("the source never touches storage, the page URL, a log or analytics", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/app/(public)/account/tickets/[id]/shareTargets.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(src).not.toMatch(/history\.(push|replace)State|location\.hash/);
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/dataLayer|gtag|fbq/);
  });
});
