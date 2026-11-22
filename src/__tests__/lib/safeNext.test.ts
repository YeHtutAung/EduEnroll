import { describe, it, expect } from "vitest";
import { safeNext } from "@/lib/auth/safeNext";

// The OAuth callback redirects to `next`; anything that could leave this
// origin falls back to /account (no open redirect).

describe("safeNext", () => {
  it.each([
    ["/account", "/account"],
    ["/account/tickets?x=1", "/account/tickets?x=1"],
    ["/enroll/abc#top", "/enroll/abc#top"],
  ])("keeps the same-origin path %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each<[string, string | null | undefined]>([
    ["protocol-relative", "//evil.example"],
    ["protocol-relative with a path", "//evil.example/account"],
    ["backslash", "/\\evil"],
    ["leading backslash", "\\evil"],
    ["backslash later in the path", "/account\\..\\evil"],
    ["absolute https", "https://evil.example"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,x"],
    ["encoded //", "%2F%2Fevil"],
    ["path then encoded //", "/%2F%2Fevil"],
    ["lower-case encoded //", "/%2f%2fevil"],
    ["encoded backslash", "/%5Cevil"],
    ["double-encoded slash", "/%252F%252Fevil"],
    ["malformed encoding", "/%E0%A4%A"],
    ["tab inside", "/\tevil"],
    ["newline inside", "/account\n//evil"],
    ["encoded newline", "/account%0A"],
    ["NUL", "/account\u0000"],
    ["relative without slash", "account"],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["over-long", "/" + "a".repeat(3000)],
  ])("%s → /account", (_name, input) => {
    expect(safeNext(input)).toBe("/account");
  });
});
