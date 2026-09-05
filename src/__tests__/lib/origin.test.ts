import { describe, it, expect, afterEach } from "vitest";
import { tenantOrigin, tenantLinkOrigin, platformOrigin } from "@/lib/origin";

const original = process.env.NEXT_PUBLIC_APP_URL;

// Delete-aware: `process.env.X = undefined` stores the STRING "undefined". The
// platformOrigin() fallback test below deletes this var, and restoring it as
// "undefined" would make new URL() throw in every later test.
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = original;
});

describe("tenantOrigin", () => {
  it("builds a tenant subdomain origin from the configured app host", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
    expect(tenantOrigin("nihonmoment")).toBe("https://nihonmoment.kuunyi.com");
  });

  it("does not include the platform www alias in tenant URLs", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.kuunyi.com";
    expect(tenantOrigin("brave")).toBe("https://brave.kuunyi.com");
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

describe("platformOrigin", () => {
  it("returns the configured app origin, never a tenant or custom domain", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
    expect(platformOrigin()).toBe("https://kuunyi.com");
  });

  it("strips any path from the configured value", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com/some/path";
    expect(platformOrigin()).toBe("https://kuunyi.com");
  });

  it("falls back to the production origin when unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(platformOrigin()).toBe("https://kuunyi.com");
  });

  it("follows the environment on staging and local", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://staging.kuunyi.com";
    expect(platformOrigin()).toBe("https://staging.kuunyi.com");
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3005";
    expect(platformOrigin()).toBe("http://localhost:3005");
  });

  // The reason this exists rather than reusing tenantOrigin(): tenantOrigin is
  // slated to become custom-domain-aware, which would move machine callbacks
  // onto tenant-controlled DNS. platformOrigin takes no tenant, so it can't.
  it("takes no tenant argument", () => {
    expect(platformOrigin.length).toBe(0);
  });
});

describe("tenantLinkOrigin — branded links for students", () => {
  const saved = process.env.TENANT_CUSTOM_DOMAINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.TENANT_CUSTOM_DOMAINS;
    else process.env.TENANT_CUSTOM_DOMAINS = saved;
  });

  it("uses the tenant's custom domain when one is configured", () => {
    process.env.TENANT_CUSTOM_DOMAINS = '{"loudermyanmar.com":"brave"}';
    expect(tenantLinkOrigin("brave")).toBe("https://loudermyanmar.com");
  });

  it("falls back to the canonical subdomain for a tenant with no custom domain", () => {
    process.env.TENANT_CUSTOM_DOMAINS = '{"loudermyanmar.com":"brave"}';
    expect(tenantLinkOrigin("nihonmoment")).toBe("https://nihonmoment.kuunyi.com");
  });

  it("falls back when no custom domains are configured at all", () => {
    delete process.env.TENANT_CUSTOM_DOMAINS;
    expect(tenantLinkOrigin("brave")).toBe("https://brave.kuunyi.com");
  });

  it("never returns another tenant's domain", () => {
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(tenantLinkOrigin("brave")).toBe("https://brave.kuunyi.com");
  });

  it("leaves tenantOrigin canonical — the allowlist must not lose the kuunyi origin", () => {
    process.env.TENANT_CUSTOM_DOMAINS = '{"loudermyanmar.com":"brave"}';
    // If these two everreturn  the same value, a student who arrived on
    // brave.kuunyi.com would be dropped from the payment return-URL allowlist.
    expect(tenantOrigin("brave")).toBe("https://brave.kuunyi.com");
    expect(tenantLinkOrigin("brave")).not.toBe(tenantOrigin("brave"));
  });
});
