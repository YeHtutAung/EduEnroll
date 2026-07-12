import { describe, it, expect, beforeAll, vi } from "vitest";
import { signOAuthState, verifyOAuthState } from "@/lib/messenger/state";

beforeAll(() => {
  process.env.MESSENGER_APP_SECRET = "test-secret-for-oauth-state-signing";
});

describe("messenger OAuth state", () => {
  const tenantId = "11c17bce-2320-474e-a31d-f6b765792e36";
  const slug = "nihonmoment";

  it("round-trips a valid signed state", () => {
    const token = signOAuthState(tenantId, slug);
    const payload = verifyOAuthState(token);
    expect(payload).not.toBeNull();
    expect(payload!.tenantId).toBe(tenantId);
    expect(payload!.slug).toBe(slug);
  });

  it("rejects a tampered payload (attacker swaps in another tenant/slug)", () => {
    const token = signOAuthState(tenantId, slug);
    const [, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ tenantId: "attacker-tenant", slug: "victim", nonce: "x", exp: Date.now() + 60000 }),
    ).toString("base64url");
    expect(verifyOAuthState(`${forged}.${sig}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signOAuthState(tenantId, slug);
    const [body] = token.split(".");
    expect(verifyOAuthState(`${body}.not-a-valid-signature`)).toBeNull();
  });

  it("rejects an expired state (past the 10-minute TTL)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const token = signOAuthState(tenantId, slug);
      expect(verifyOAuthState(token)).not.toBeNull(); // valid immediately
      vi.setSystemTime(new Date("2026-01-01T00:11:00Z")); // +11 min
      expect(verifyOAuthState(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed input", () => {
    expect(verifyOAuthState(null)).toBeNull();
    expect(verifyOAuthState("")).toBeNull();
    expect(verifyOAuthState("no-dot")).toBeNull();
  });
});
