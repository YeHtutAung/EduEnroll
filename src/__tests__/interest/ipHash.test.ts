import { describe, it, expect } from "vitest";
import { canonicalIp, hashIp } from "@/lib/interest/ipHash";

describe("canonicalIp", () => {
  it("lowercases IPv6", () => {
    expect(canonicalIp("2001:DB8::1")).toBe("2001:db8::1");
  });

  it("reduces IPv4-mapped IPv6 to the IPv4 form", () => {
    expect(canonicalIp("::ffff:192.168.1.1")).toBe("192.168.1.1");
  });

  it("strips surrounding whitespace and brackets", () => {
    expect(canonicalIp(" [2001:db8::1] ")).toBe("2001:db8::1");
  });

  it("returns 'unknown' for empty input, so a missing address still buckets", () => {
    expect(canonicalIp("")).toBe("unknown");
    expect(canonicalIp(null)).toBe("unknown");
  });
});

describe("hashIp", () => {
  it("returns lowercase hex sha256, matching the column CHECK", () => {
    expect(hashIp("1.2.3.4", "secret")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives one bucket per client regardless of representation", () => {
    expect(hashIp("::ffff:1.2.3.4", "s")).toBe(hashIp("1.2.3.4", "s"));
  });

  it("changes with the secret", () => {
    expect(hashIp("1.2.3.4", "a")).not.toBe(hashIp("1.2.3.4", "b"));
  });
});
