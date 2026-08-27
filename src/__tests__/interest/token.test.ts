import { describe, it, expect } from "vitest";
import { mintPriorityToken, hashPriorityToken } from "@/lib/interest/token";

describe("hashPriorityToken", () => {
  it("returns lowercase hex sha256, matching the column CHECK", () => {
    const h = hashPriorityToken("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashPriorityToken("abc")).toBe(hashPriorityToken("abc"));
  });
});

describe("mintPriorityToken", () => {
  it("produces a url-safe token with no padding", () => {
    const { token } = mintPriorityToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a distinct token each call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintPriorityToken().token));
    expect(seen.size).toBe(50);
  });

  it("returns a hash and prefix consistent with the token", () => {
    const { token, tokenHash, tokenPrefix } = mintPriorityToken();
    expect(tokenHash).toBe(hashPriorityToken(token));
    expect(tokenPrefix).toBe(token.slice(0, 8));
  });
});
