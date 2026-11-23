import { describe, expect, it } from "vitest";
import { isAccountEmailKey, lockedOrderEmail } from "@/lib/enrollment/accountEmail";
import { withAccountEmail } from "@/server/enrollment/protection";

// One rule for which form answers are the order's email on a protected event:
// the pages lock exactly these fields and the server overwrites exactly these.

describe("isAccountEmailKey", () => {
  it.each(["email", "email_address", "custom_email_1", "custom_email_1732000000000"])("%s is an account email key", (key) => {
    expect(isAccountEmailKey(key)).toBe(true);
  });

  it.each(["guardian_email", "Email", "emailaddress", "custom_text_1", "custom_emailx", "name_en", ""])(
    "%s is not",
    (key) => {
      expect(isAccountEmailKey(key)).toBe(false);
    },
  );

  it("matches what withAccountEmail overwrites, key for key", () => {
    const fd = {
      email: "typed@example.com",
      email_address: "typed@example.com",
      custom_email_9: "typed@example.com",
      guardian_email: "guardian@example.com",
      custom_text_1: "typed@example.com",
    };
    const out = withAccountEmail(fd, "acct@example.com");
    for (const key of Object.keys(fd)) {
      expect(out[key] === "acct@example.com").toBe(isAccountEmailKey(key));
    }
  });
});

describe("lockedOrderEmail", () => {
  it("is null on an unprotected or signed-out page", () => {
    expect(lockedOrderEmail("order@example.com", null)).toBeNull();
  });

  it("shows the order's stored email, not the session's", () => {
    expect(lockedOrderEmail("order@example.com", "session@example.com")).toBe("order@example.com");
  });

  it("trims the stored email", () => {
    expect(lockedOrderEmail("  order@example.com ", "session@example.com")).toBe("order@example.com");
  });

  it.each([[undefined], [null], [""], ["   "]])("falls back to the session's email when the order has none (%j)", (stored) => {
    expect(lockedOrderEmail(stored, "session@example.com")).toBe("session@example.com");
  });
});
