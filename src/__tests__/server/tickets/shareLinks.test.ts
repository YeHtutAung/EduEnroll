import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { newShareToken, hashShareToken, isShareToken, shareLinkUrl } from "@/server/tickets/shareLinks";

describe("share link tokens", () => {
  it("newShareToken is 43 base64url characters and unique", () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("hashShareToken is the SHA-256 hex of the token", () => {
    const t = newShareToken();
    const h = hashShareToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash("sha256").update(t, "utf8").digest("hex"));
  });

  it("isShareToken accepts a fresh token and rejects malformed input", () => {
    const t = newShareToken();
    expect(isShareToken(t)).toBe(true);
    expect(isShareToken("")).toBe(false);
    expect(isShareToken(t.slice(0, 42))).toBe(false);
    expect(isShareToken(t + "A")).toBe(false);
    expect(isShareToken(t.slice(0, 42) + "+")).toBe(false);
    expect(isShareToken(t.slice(0, 42) + "/")).toBe(false);
    expect(isShareToken(t.slice(0, 42) + "=")).toBe(false);
    expect(isShareToken(undefined)).toBe(false);
    expect(isShareToken(123)).toBe(false);
  });

  it("shareLinkUrl puts the token in the fragment", () => {
    const t = newShareToken();
    expect(shareLinkUrl("https://skyfestivalmm.com", t)).toBe(`https://skyfestivalmm.com/t/claim#${t}`);
  });
});
