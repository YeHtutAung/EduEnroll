import { describe, it, expect } from "vitest";
import { isInAppBrowser } from "@/lib/inAppBrowser";

// Google refuses OAuth inside embedded web views, so /account hides the Google
// button there. Real-world user agents, shortened where the tail is irrelevant.

const IN_APP: [string, string][] = [
  [
    "Facebook (FBAN)",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0.30.104;FBBV/123]",
  ],
  [
    "Facebook (FBAV only)",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 [FBAV/440.0.0.31.105;]",
  ],
  [
    "Facebook (FB_IAB)",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A]",
  ],
  [
    "Instagram",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 307.0.0.34.111",
  ],
  [
    "Messenger",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Messenger",
  ],
  [
    "LINE",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.18.0",
  ],
  [
    "Viber",
    "Mozilla/5.0 (Linux; Android 12; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36 Viber/21.0",
  ],
  [
    "WeChat",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40",
  ],
  [
    "Android WebView",
    "Mozilla/5.0 (Linux; Android 13; SM-G991B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36",
  ],
];

const BROWSERS: [string, string][] = [
  [
    "Chrome (Android)",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36",
  ],
  [
    "Chrome (desktop)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ],
  [
    "Safari (iOS)",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  ],
  [
    "Samsung Internet",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  ],
  ["Firefox (Android)", "Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0"],
  ["Firefox (desktop)", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0"],
];

describe("isInAppBrowser", () => {
  it.each(IN_APP)("%s → true", (_name, ua) => {
    expect(isInAppBrowser(ua)).toBe(true);
  });

  it.each(BROWSERS)("%s → false", (_name, ua) => {
    expect(isInAppBrowser(ua)).toBe(false);
  });

  it.each([[""], [null], [undefined]])("%s → false", (ua) => {
    expect(isInAppBrowser(ua)).toBe(false);
  });
});
