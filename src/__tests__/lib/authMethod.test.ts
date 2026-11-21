import { describe, it, expect } from "vitest";
import { isPasswordSession, sessionAuthMethods } from "@/lib/authMethod";

// Builds an unsigned token with the given payload. The helper only decodes;
// signature checking is getUser()'s job, done before this is ever called.
function token(payload: unknown): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

describe("sessionAuthMethods", () => {
  it("reads object-form amr entries", () => {
    expect(sessionAuthMethods(token({ amr: [{ method: "password", timestamp: 1 }] }))).toEqual(["password"]);
  });

  it("reads string-form amr entries", () => {
    expect(sessionAuthMethods(token({ amr: ["otp"] }))).toEqual(["otp"]);
  });

  it("returns [] for a missing amr, a non-array amr, or junk", () => {
    expect(sessionAuthMethods(token({ sub: "x" }))).toEqual([]);
    expect(sessionAuthMethods(token({ amr: "password" }))).toEqual([]);
    expect(sessionAuthMethods("not-a-jwt")).toEqual([]);
    expect(sessionAuthMethods("a.%%%.c")).toEqual([]);
    expect(sessionAuthMethods(null)).toEqual([]);
    expect(sessionAuthMethods(undefined)).toEqual([]);
  });

  it("decodes base64url payloads that need padding", () => {
    // A payload whose base64url length is not a multiple of 4.
    expect(sessionAuthMethods(token({ amr: [{ method: "password" }], x: "ab" }))).toEqual(["password"]);
  });
});

describe("isPasswordSession", () => {
  it("is true only when password is among the methods", () => {
    expect(isPasswordSession(token({ amr: [{ method: "password" }] }))).toBe(true);
    expect(isPasswordSession(token({ amr: [{ method: "otp" }, { method: "password" }] }))).toBe(true);
    expect(isPasswordSession(token({ amr: [{ method: "otp" }] }))).toBe(false);
    expect(isPasswordSession(token({ amr: [{ method: "magiclink" }] }))).toBe(false);
    expect(isPasswordSession(token({ amr: [{ method: "recovery" }] }))).toBe(false);
    expect(isPasswordSession(null)).toBe(false);
  });
});

import { tokenClaim, isEmailCodeSession } from "@/lib/authMethod";

describe("tokenClaim", () => {
  it("reads a string claim", () => {
    expect(tokenClaim(token({ session_id: "s-1" }), "session_id")).toBe("s-1");
  });
  it("returns null for a missing, non-string or malformed claim", () => {
    expect(tokenClaim(token({}), "session_id")).toBeNull();
    expect(tokenClaim(token({ session_id: 7 }), "session_id")).toBeNull();
    expect(tokenClaim("not-a-jwt", "session_id")).toBeNull();
  });
});

describe("isEmailCodeSession", () => {
  it("is true only when amr has otp", () => {
    expect(isEmailCodeSession(token({ amr: [{ method: "otp", timestamp: 1 }] }))).toBe(true);
    expect(isEmailCodeSession(token({ amr: [{ method: "password", timestamp: 1 }] }))).toBe(false);
    expect(isEmailCodeSession(token({ amr: [{ method: "magiclink", timestamp: 1 }] }))).toBe(false);
  });
});
