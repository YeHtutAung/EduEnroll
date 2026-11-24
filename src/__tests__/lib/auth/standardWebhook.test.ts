import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyStandardWebhook } from "@/lib/auth/standardWebhook";

// ─── Standard Webhooks signature check (Supabase Send Email Hook) ───────────
// Signed content is `${id}.${timestamp}.${body}`, HMAC-SHA256 keyed with the
// base64-decoded secret. The secret here is a throwaway test value.

const RAW_KEY = Buffer.from("throwaway-test-key-0123456789abcdef");
const B64 = RAW_KEY.toString("base64");
const SECRET = `v1,whsec_${B64}`;
const NOW = 1_800_000_000;
const ID = "msg_test_1";
const BODY = JSON.stringify({ user: { email: "x@example.test" }, email_data: { token: "123456" } });

function sign(body: string, ts: number | string = NOW, key: Buffer = RAW_KEY, id = ID): string {
  return createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

function check(over: Partial<Parameters<typeof verifyStandardWebhook>[0]> = {}): boolean {
  return verifyStandardWebhook({
    secret: SECRET,
    id: ID,
    timestamp: String(NOW),
    signature: `v1,${sign(BODY)}`,
    body: BODY,
    nowSeconds: NOW,
    ...over,
  });
}

describe("verifyStandardWebhook", () => {
  it("accepts a valid signature", () => {
    expect(check()).toBe(true);
  });

  it("accepts the secret with the v1,whsec_ prefix, with whsec_ only, and bare", () => {
    expect(check({ secret: `v1,whsec_${B64}` })).toBe(true);
    expect(check({ secret: `whsec_${B64}` })).toBe(true);
    expect(check({ secret: B64 })).toBe(true);
  });

  it("accepts when one of several entries matches", () => {
    const wrong = createHmac("sha256", Buffer.from("other")).update("x").digest("base64");
    expect(check({ signature: `v1,${wrong} v1,${sign(BODY)}` })).toBe(true);
  });

  it("accepts a timestamp exactly 300 s away either side", () => {
    expect(check({ nowSeconds: NOW + 300 })).toBe(true);
    expect(check({ nowSeconds: NOW - 300 })).toBe(true);
  });

  it("rejects a changed body", () => {
    expect(check({ body: BODY.replace("123456", "654321") })).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(check({ secret: `v1,whsec_${Buffer.from("not-the-key").toString("base64")}` })).toBe(false);
  });

  it("rejects an empty secret, even with a signature made with an empty key", () => {
    const emptyKeySig = sign(BODY, NOW, Buffer.alloc(0));
    expect(check({ secret: "", signature: `v1,${emptyKeySig}` })).toBe(false);
    expect(check({ secret: "v1,whsec_", signature: `v1,${emptyKeySig}` })).toBe(false);
  });

  it("rejects a missing id, timestamp or signature header", () => {
    expect(check({ id: null })).toBe(false);
    expect(check({ timestamp: null })).toBe(false);
    expect(check({ signature: null })).toBe(false);
  });

  it("rejects an entry without v1,", () => {
    expect(check({ signature: sign(BODY) })).toBe(false);
    expect(check({ signature: `v2,${sign(BODY)}` })).toBe(false);
    expect(check({ signature: "v1," })).toBe(false);
  });

  it("rejects a timestamp more than 300 s old or more than 300 s in the future", () => {
    expect(check({ nowSeconds: NOW + 301 })).toBe(false);
    expect(check({ nowSeconds: NOW - 301 })).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    const ts = `${NOW}abc`;
    expect(check({ timestamp: ts, signature: `v1,${sign(BODY, ts)}` })).toBe(false);
    expect(check({ timestamp: "-1" })).toBe(false);
  });

  it("returns false, not an exception, for a signature of a different length", () => {
    expect(() => check({ signature: "v1,AAAA" })).not.toThrow();
    expect(check({ signature: "v1,AAAA" })).toBe(false);
  });
});
