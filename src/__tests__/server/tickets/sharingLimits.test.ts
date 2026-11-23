import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const consume = vi.fn();
vi.mock("@/server/buyers/rateLimit", () => ({
  consumeRateLimit: (...args: unknown[]) => consume(...args),
}));

import { limitShare, limitShareCancel, limitGiveBack, limitClaim, limitPreview } from "@/server/tickets/sharingLimits";

const admin = {} as unknown as SupabaseClient<Database>;
const headers = new Headers({ "x-forwarded-for": "203.0.113.9" });

beforeEach(() => {
  consume.mockReset();
  consume.mockResolvedValue("ok");
});

describe("sharing rate limits", () => {
  it("limitShare: share:<buyer>, 3600 s, 20", async () => {
    expect(await limitShare(admin, "b1")).toBe("ok");
    expect(consume).toHaveBeenCalledWith(admin, "share:b1", 3600, 20);
  });

  it("limitShareCancel: sharecancel:<buyer>, 3600 s, 20", async () => {
    expect(await limitShareCancel(admin, "b1")).toBe("ok");
    expect(consume).toHaveBeenCalledWith(admin, "sharecancel:b1", 3600, 20);
  });

  it("limitGiveBack: giveback:<buyer>, 3600 s, 10", async () => {
    await limitGiveBack(admin, "b1");
    expect(consume).toHaveBeenCalledWith(admin, "giveback:b1", 3600, 10);
  });

  it("limitClaim: buyer key (900 s, 10) then ip key (900 s, 30)", async () => {
    expect(await limitClaim(admin, "b1", headers)).toBe("ok");
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenNthCalledWith(1, admin, "claim:b1", 900, 10);
    const [, key, window, limit] = consume.mock.calls[1];
    expect(key).toMatch(/^claimip:/);
    expect([window, limit]).toEqual([900, 30]);
  });

  it("limitPreview: claimpreview:<buyer> (900 s, 30) then the same ip key", async () => {
    await limitPreview(admin, "b1", headers);
    await limitClaim(admin, "b1", headers);
    expect(consume).toHaveBeenNthCalledWith(1, admin, "claimpreview:b1", 900, 30);
    expect(consume.mock.calls[1][1]).toBe(consume.mock.calls[3][1]);
  });

  it("the ip key hides the ip and is 30 characters", async () => {
    await limitClaim(admin, "b1", headers);
    const key = consume.mock.calls[1][1] as string;
    expect(key).not.toContain("203.0.113.9");
    expect(key).toHaveLength(30);
  });

  it("returns the first result that isn't ok and skips the ip call", async () => {
    consume.mockResolvedValueOnce("limited");
    expect(await limitClaim(admin, "b1", headers)).toBe("limited");
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("returns the ip result when the buyer is ok but the ip is not", async () => {
    consume.mockResolvedValueOnce("ok").mockResolvedValueOnce("unavailable");
    expect(await limitPreview(admin, "b1", headers)).toBe("unavailable");
  });
});
