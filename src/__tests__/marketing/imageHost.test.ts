import { describe, it, expect } from "vitest";
import { marketingRemotePatterns } from "@/lib/marketing/imageHost.mjs";

const PATH = "/storage/v1/object/public/marketing-assets/**";

describe("marketingRemotePatterns", () => {
  it("pins protocol, host and path", () => {
    expect(marketingRemotePatterns("https://abc.supabase.co", true)).toEqual([
      { protocol: "https", hostname: "abc.supabase.co", port: "", pathname: PATH },
    ]);
  });

  it("keeps a local port", () => {
    expect(marketingRemotePatterns("http://127.0.0.1:54321", true)).toEqual([
      { protocol: "http", hostname: "127.0.0.1", port: "54321", pathname: PATH },
    ]);
  });

  it.each([undefined, "", "not a url", "ftp://abc.supabase.co"])("fails a build on %s", (v) => {
    expect(() => marketingRemotePatterns(v, true)).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it.each([undefined, "", "not a url"])("doesn't fail other commands on %s", (v) => {
    expect(marketingRemotePatterns(v, false)).toEqual([]);
  });
});
