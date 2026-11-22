import { describe, it, expect } from "vitest";
import { isSameOriginRequest } from "@/lib/auth/sameOrigin";

const req = (headers: Record<string, string>) =>
  new Request("https://sky.kuunyi.com/api/x", { method: "POST", headers });

describe("isSameOriginRequest", () => {
  it.each([
    ["same-origin fetch", { "sec-fetch-site": "same-origin", origin: "https://sky.kuunyi.com", host: "sky.kuunyi.com" }, true],
    ["no browser headers (not a browser; the cookie still decides)", { host: "sky.kuunyi.com" }, true],
    ["host match is case-insensitive", { origin: "https://SKY.kuunyi.com", host: "sky.KUUNYI.com" }, true],
    ["sec-fetch-site cross-site", { "sec-fetch-site": "cross-site", host: "sky.kuunyi.com" }, false],
    ["sec-fetch-site same-site (a sibling tenant subdomain)", { "sec-fetch-site": "same-site", host: "sky.kuunyi.com" }, false],
    ["Origin of a sibling subdomain", { origin: "https://beats.kuunyi.com", host: "sky.kuunyi.com" }, false],
    ["Origin null", { origin: "null", host: "sky.kuunyi.com" }, false],
    ["Origin present, Host missing", { origin: "https://sky.kuunyi.com" }, false],
  ])("%s", (_name, headers, ok) => {
    const r = req(headers as Record<string, string>);
    // Request drops a forbidden `host` header in some runtimes; set it explicitly when given.
    if (!("host" in headers)) r.headers.delete("host");
    expect(isSameOriginRequest(r)).toBe(ok);
  });
});
