import { describe, it, expect, afterEach } from "vitest";
import { tenantOrigin } from "@/lib/origin";

const original = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = original;
});

describe("tenantOrigin", () => {
  it("builds a tenant subdomain origin from the configured app host", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
    expect(tenantOrigin("nihonmoment")).toBe("https://nihonmoment.kuunyi.com");
  });

  it("ignores the inbound host entirely (only subdomain + configured host matter)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
    // No matter what an attacker sends as Host, the origin is derived from config.
    expect(tenantOrigin("acme")).toBe("https://acme.kuunyi.com");
  });

  it("falls back to the app origin when subdomain is missing", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
    expect(tenantOrigin(null)).toBe("https://kuunyi.com");
    expect(tenantOrigin("")).toBe("https://kuunyi.com");
  });

  it("returns the origin as-is for localhost (no tenant subdomains in dev)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3005";
    expect(tenantOrigin("nihonmoment")).toBe("http://localhost:3005");
  });
});
