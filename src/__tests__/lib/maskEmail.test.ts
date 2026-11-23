import { describe, it, expect } from "vitest";
import { maskEmail } from "@/lib/maskEmail";

describe("maskEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("kyaw@gmail.com")).toBe("k***@gmail.com");
    expect(maskEmail("a@x.io")).toBe("a***@x.io");
  });

  it("returns *** for anything that is not a usable email", () => {
    for (const v of ["not-an-email", "", null, undefined, "@x.io", "a@", "a@b@c.io"]) {
      expect(maskEmail(v)).toBe("***");
    }
  });
});
