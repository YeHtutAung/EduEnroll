import { describe, it, expect } from "vitest";
import { resolveSendMode } from "@/server/conversions/config";

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe("resolveSendMode", () => {
  it("sends live in production, ignoring a test code", () => {
    expect(
      resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "production", CONVERSIONS_SKY_META_TOKEN: "T", CONVERSIONS_SKY_META_TEST_CODE: "C" })),
    ).toEqual({ kind: "send", token: "T", testCode: null });
  });
  it("sends with the test code outside production", () => {
    expect(
      resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "preview", CONVERSIONS_SKY_META_TOKEN: "T", CONVERSIONS_SKY_META_TEST_CODE: "C" })),
    ).toEqual({ kind: "send", token: "T", testCode: "C" });
  });
  it("holds outside production with no test code", () => {
    expect(resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "preview", CONVERSIONS_SKY_META_TOKEN: "T" }))).toEqual({ kind: "hold", reason: "no_test_code" });
  });
  it("holds with no token, and names the variable without a value", () => {
    expect(resolveSendMode("SKY", "tiktok", env({ VERCEL_ENV: "production" }))).toEqual({ kind: "hold", reason: "missing CONVERSIONS_SKY_TIKTOK_TOKEN" });
  });
  it("never reads another tenant's token", () => {
    expect(resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "production", CONVERSIONS_OTHER_META_TOKEN: "T" })).kind).toBe("hold");
  });
  it("holds when VERCEL_ENV is unset", () => {
    expect(resolveSendMode("SKY", "meta", env({ CONVERSIONS_SKY_META_TOKEN: "T" }))).toEqual({ kind: "hold", reason: "no_test_code" });
  });
  it("treats a whitespace-only token as missing", () => {
    expect(resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "production", CONVERSIONS_SKY_META_TOKEN: "   " }))).toEqual({
      kind: "hold",
      reason: "missing CONVERSIONS_SKY_META_TOKEN",
    });
  });
  it("treats a whitespace-only test code as none", () => {
    expect(
      resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "preview", CONVERSIONS_SKY_META_TOKEN: "T", CONVERSIONS_SKY_META_TEST_CODE: " 	 " })),
    ).toEqual({ kind: "hold", reason: "no_test_code" });
  });
  it("trims the token and test code it uses", () => {
    expect(
      resolveSendMode("SKY", "meta", env({ VERCEL_ENV: "preview", CONVERSIONS_SKY_META_TOKEN: " T ", CONVERSIONS_SKY_META_TEST_CODE: " C " })),
    ).toEqual({ kind: "send", token: "T", testCode: "C" });
  });
});
