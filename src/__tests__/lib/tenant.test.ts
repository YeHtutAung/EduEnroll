import { describe, it, expect, afterEach } from "vitest";
import { customOriginForTenant, extractSubdomainFromHost } from "@/lib/tenant";

const original = process.env.TENANT_CUSTOM_DOMAINS;

// Delete-aware: `process.env.X = undefined` stores the STRING "undefined", so
// the "no custom domains configured" test would leave a malformed map behind
// and later tests would parse it instead of an absent one.
afterEach(() => {
  if (original === undefined) delete process.env.TENANT_CUSTOM_DOMAINS;
  else process.env.TENANT_CUSTOM_DOMAINS = original;
});

function withMap(json: string) {
  process.env.TENANT_CUSTOM_DOMAINS = json;
}

describe("extractSubdomainFromHost — known hosts (regression)", () => {
  it("still resolves kuunyi subdomains, vercel previews and localhost", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("tmf.kuunyi.com")).toBe("tmf");
    expect(extractSubdomainFromHost("tmf.staging.kuunyi.com")).toBe("tmf");
    expect(extractSubdomainFromHost("www.kuunyi.com")).toBeNull();
    expect(extractSubdomainFromHost("kuunyi.com")).toBeNull();
    expect(extractSubdomainFromHost("tmf.edu-enroll-xi.vercel.app")).toBe("tmf");
    expect(extractSubdomainFromHost("edu-enroll-xi.vercel.app")).toBeNull();
    expect(extractSubdomainFromHost("tmf.localhost:3005")).toBe("tmf");
  });
});

// The allowlist property: inference is gone. Tenant isolation must not depend
// on Vercel's domain assignment being the only thing standing in the way.
describe("extractSubdomainFromHost — unconfigured hosts never resolve", () => {
  it("refuses to infer a tenant from an arbitrary domain", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("flashtic.evil.com")).toBeNull();
    expect(extractSubdomainFromHost("www.evil.com")).toBeNull();
    expect(extractSubdomainFromHost("unknown.example.org")).toBeNull();
    expect(extractSubdomainFromHost("tmf.kuunyi.com.evil.com")).toBeNull();
  });

  // Previously resolved to tenant "192" — LAN testing per project notes.
  it("does not treat a bare IP as a tenant", () => {
    expect(extractSubdomainFromHost("192.168.50.3:3005")).toBeNull();
  });
});

describe("extractSubdomainFromHost — custom domains", () => {
  it("resolves a configured custom domain to its tenant slug", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("flashtic.com")).toBe("flashtic");
  });

  it("treats www, ports, case and the FQDN trailing dot as the same domain", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("www.flashtic.com")).toBe("flashtic");
    expect(extractSubdomainFromHost("FlashTic.com:3005")).toBe("flashtic");
    expect(extractSubdomainFromHost("flashtic.com.")).toBe("flashtic");
  });

  it("returns null when no custom domains are configured", () => {
    delete process.env.TENANT_CUSTOM_DOMAINS;
    expect(extractSubdomainFromHost("flashtic.com")).toBeNull();
  });
});

describe("extractSubdomainFromHost — env hardening", () => {
  // Runs on every request to every domain: a typo must never 500 the platform.
  it("never throws on a malformed env var", () => {
    withMap("{not json");
    expect(() => extractSubdomainFromHost("flashtic.com")).not.toThrow();
    expect(extractSubdomainFromHost("flashtic.com")).toBeNull();
    expect(extractSubdomainFromHost("tmf.kuunyi.com")).toBe("tmf"); // unaffected
  });

  it("ignores a well-formed value of the wrong shape", () => {
    withMap('["flashtic.com"]');
    expect(extractSubdomainFromHost("flashtic.com")).toBeNull();
  });

  it("drops entries with non-string or invalid slugs", () => {
    withMap('{"a.com":123,"b.com":"BAD SLUG","c.com":"ok"}');
    expect(extractSubdomainFromHost("a.com")).toBeNull();
    expect(extractSubdomainFromHost("b.com")).toBeNull();
    expect(extractSubdomainFromHost("c.com")).toBe("ok");
  });

  it("rejects a slug with a trailing hyphen", () => {
    withMap('{"a.com":"school-","b.com":"-school","c.com":"ok-slug"}');
    expect(extractSubdomainFromHost("a.com")).toBeNull();
    expect(extractSubdomainFromHost("b.com")).toBeNull();
    expect(extractSubdomainFromHost("c.com")).toBe("ok-slug");
  });

  it("drops malformed hostnames", () => {
    withMap('{"not a host":"x","-bad.com":"y","ok.com":"z"}');
    expect(extractSubdomainFromHost("ok.com")).toBe("z");
  });

  // An env typo must not let a custom domain claim the platform's own hosts.
  it("rejects reserved platform hosts", () => {
    withMap('{"kuunyi.com":"evil","tmf.kuunyi.com":"evil","x.vercel.app":"evil"}');
    expect(extractSubdomainFromHost("kuunyi.com")).toBeNull();
    expect(extractSubdomainFromHost("tmf.kuunyi.com")).toBe("tmf"); // real resolver wins
  });

  it("keeps the first host when two map to the same tenant", () => {
    withMap('{"one.com":"flashtic","two.com":"flashtic"}');
    expect(extractSubdomainFromHost("one.com")).toBe("flashtic");
    expect(extractSubdomainFromHost("two.com")).toBeNull();
  });

  it("does not resolve prototype keys", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(extractSubdomainFromHost("constructor")).toBeNull();
    expect(extractSubdomainFromHost("__proto__")).toBeNull();
    expect(extractSubdomainFromHost("toString")).toBeNull();
  });
});

describe("customOriginForTenant", () => {
  it("returns the tenant's configured custom origin", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(customOriginForTenant("flashtic")).toBe("https://flashtic.com");
  });

  it("returns null for a tenant without one", () => {
    withMap('{"flashtic.com":"flashtic"}');
    expect(customOriginForTenant("nihon-moment")).toBeNull();
  });

  it("returns null when the map is unset, empty or invalid", () => {
    delete process.env.TENANT_CUSTOM_DOMAINS;
    expect(customOriginForTenant("flashtic")).toBeNull();
    withMap(""); // set-but-empty is a distinct case from unset
    expect(customOriginForTenant("flashtic")).toBeNull();
    withMap("{not json");
    expect(customOriginForTenant("flashtic")).toBeNull();
  });

  // Entries the parser drops must not be reachable through the back door.
  it("returns null for a tenant whose entry was rejected", () => {
    withMap('{"kuunyi.com":"evil","bad host":"broken"}');
    expect(customOriginForTenant("evil")).toBeNull();
    expect(customOriginForTenant("broken")).toBeNull();
  });

  // parseTenantCustomDomains keeps only the first host per tenant, so this is
  // unambiguous by construction rather than by luck.
  it("is unambiguous when two hosts name the same tenant", () => {
    withMap('{"one.com":"flashtic","two.com":"flashtic"}');
    expect(customOriginForTenant("flashtic")).toBe("https://one.com");
  });
});
