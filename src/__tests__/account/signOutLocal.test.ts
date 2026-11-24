import { describe, expect, it, vi } from "vitest";
import { authCookieNames, signOutLocal } from "@/app/(public)/account/signOutLocal";

/** A document.cookie stand-in that records every assignment. */
function fakeDoc(cookie: string) {
  const writes: string[] = [];
  return {
    writes,
    get cookie() {
      return cookie;
    },
    set cookie(value: string) {
      writes.push(value);
    },
  };
}

const JAR =
  "x-tenant-slug=brave; sb-abc-auth-token.0=part0; sb-abc-auth-token.1=part1; " +
  "sb-abc-auth-token-code-verifier=v; other=1";

describe("authCookieNames", () => {
  it("picks the Supabase session cookie and its chunks only", () => {
    expect(authCookieNames(JAR)).toEqual(["sb-abc-auth-token.0", "sb-abc-auth-token.1"]);
    expect(authCookieNames("sb-abc-auth-token=x")).toEqual(["sb-abc-auth-token"]);
    expect(authCookieNames("")).toEqual([]);
  });
});

describe("signOutLocal", () => {
  it("leaves the cookies to auth-js when sign-out succeeds", async () => {
    const doc = fakeDoc(JAR);
    const signOut = vi.fn().mockResolvedValue({ error: null });
    await signOutLocal({ auth: { signOut } }, doc);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(doc.writes).toEqual([]);
  });

  it("expires the session cookies when sign-out returns an error", async () => {
    const doc = fakeDoc(JAR);
    const signOut = vi.fn().mockResolvedValue({ error: new Error("500") });
    await signOutLocal({ auth: { signOut } }, doc);
    expect(doc.writes).toEqual([
      "sb-abc-auth-token.0=; Path=/; Max-Age=0; SameSite=Lax",
      "sb-abc-auth-token.1=; Path=/; Max-Age=0; SameSite=Lax",
    ]);
  });

  it("expires the session cookies when sign-out throws", async () => {
    const doc = fakeDoc("sb-abc-auth-token=x");
    const signOut = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(signOutLocal({ auth: { signOut } }, doc)).resolves.toBeUndefined();
    expect(doc.writes).toEqual(["sb-abc-auth-token=; Path=/; Max-Age=0; SameSite=Lax"]);
  });

  it("never throws, even if the cookies can't be written", async () => {
    const doc = {
      get cookie() {
        return "sb-abc-auth-token=x";
      },
      set cookie(_v: string) {
        throw new Error("blocked");
      },
    };
    const signOut = vi.fn().mockResolvedValue({ error: new Error("500") });
    await expect(signOutLocal({ auth: { signOut } }, doc)).resolves.toBeUndefined();
  });
});
