import { describe, expect, it } from "vitest";
import {
  emailBlockedFor,
  emailBlockedMessage,
  emailTypoToConfirm,
  isValidEmail,
  replaceEmailInFormData,
  suggestEmailCorrection,
} from "@/lib/enrollment/emailAddress";

describe("suggestEmailCorrection", () => {
  it.each([
    ["buyer@gmail.con", "buyer@gmail.com"],
    ["a@gmial.com", "a@gmail.com"],
    ["a@gmai.com", "a@gmail.com"],
    ["a@gmaill.com", "a@gmail.com"],
    ["a@gmail.co", "a@gmail.com"],
    ["a@gmail.cm", "a@gmail.com"],
    ["a@gmailcom", "a@gmail.com"],
    ["a@gmal.con", "a@gmail.com"],
    ["a@yaho.com", "a@yahoo.com"],
    ["a@hotmial.com", "a@hotmail.com"],
    ["a@outlok.com", "a@outlook.com"],
    ["a@iclod.com", "a@icloud.com"],
    ["a@company.con", "a@company.com"],
  ])("suggests a fix for %s", (typed, expected) => {
    expect(suggestEmailCorrection(typed)).toBe(expected);
  });

  it("keeps the buyer's own spelling of the part before the @", () => {
    expect(suggestEmailCorrection("Nang.Su@GMAIL.CON")).toBe("Nang.Su@gmail.com");
  });

  it("ignores spaces around the address", () => {
    expect(suggestEmailCorrection("  a@gmail.con ")).toBe("a@gmail.com");
  });

  it.each([
    "a@gmail.com",
    "a@GMAIL.com",
    "a@yahoo.com",
    "a@mail.com",
    "a@ymail.com",
    "a@me.com",
    "a@company.com.mm",
    "a@skyfestivalmm.com",
    "a@school.edu.mm",
  ])("leaves %s alone", (address) => {
    expect(suggestEmailCorrection(address)).toBeNull();
  });

  it.each(["", "nothing", "@gmail.con", "a@"])("has nothing to say about %j", (address) => {
    expect(suggestEmailCorrection(address)).toBeNull();
  });
});

// Domains seen on real orders, with how each must behave. Buyers' company domains
// are replaced with a stand-in, because this repository is public.
describe("production's domains", () => {
  it.each([
    "gmail.con",
    "gamil.com",
    "gmai.com",
    "gmail.tcom",
    "gmail.co",
    "gmil.com",
    "gmail.comq",
    "gmail.ccom",
    "gmail..com",
    "gnail.com",
    "gmail.comm",
    "gmial.com",
    "gamail.com",
  ])("refuses %s and offers gmail.com", (domain) => {
    expect(emailBlockedFor(`buyer@${domain}`)).toBe("buyer@gmail.com");
  });

  it("queries email.com but doesn't refuse it, because it is real", () => {
    expect(suggestEmailCorrection("buyer@email.com")).toBe("buyer@gmail.com");
    expect(emailBlockedFor("buyer@email.com")).toBeNull();
  });

  it.each([
    "gmail.com",
    "icloud.com",
    "googlemail.com",
    "some-company.com",
    "yahoo.com",
    "yahoo.com.sg",
    "kuunyi.com",
    "protonmail.com",
    "mail.com",
    "university.edu",
  ])("says nothing about %s", (domain) => {
    expect(suggestEmailCorrection(`buyer@${domain}`)).toBeNull();
    expect(emailBlockedFor(`buyer@${domain}`)).toBeNull();
  });
});

describe("emailBlockedFor", () => {
  it("only warns about near-misses of other providers", () => {
    expect(suggestEmailCorrection("a@yaho.com")).toBe("a@yahoo.com");
    expect(emailBlockedFor("a@yaho.com")).toBeNull();
  });

  it("only warns about a .con ending on any other domain", () => {
    expect(suggestEmailCorrection("a@company.con")).toBe("a@company.com");
    expect(emailBlockedFor("a@company.con")).toBeNull();
  });

  it("ignores capitals and spaces", () => {
    expect(emailBlockedFor("  Buyer@GMAIL.CON ")).toBe("Buyer@gmail.com");
  });

  it("names the correction in both languages", () => {
    const message = emailBlockedMessage("a@gmail.com");
    expect(message.en).toContain("a@gmail.com");
    expect(message.mm).toContain("a@gmail.com");
  });
});

describe("emailTypoToConfirm", () => {
  it("stops the form once, then lets the same address through", () => {
    const warned = new Set<string>();
    expect(emailTypoToConfirm("a@gmail.con", warned)).toBe("a@gmail.com");
    expect(emailTypoToConfirm("a@gmail.con", warned)).toBeNull();
  });

  it("stops again when the buyer types a different mistake", () => {
    const warned = new Set<string>();
    emailTypoToConfirm("a@gmail.con", warned);
    expect(emailTypoToConfirm("a@gmial.com", warned)).toBe("a@gmail.com");
  });

  it("never stops a correct address", () => {
    expect(emailTypoToConfirm("a@gmail.com", new Set())).toBeNull();
  });
});

describe("isValidEmail", () => {
  it("accepts an ordinary address, even one that looks mistyped", () => {
    expect(isValidEmail("a.b+c@gmail.com")).toBe(true);
    expect(isValidEmail("a@gmail.con")).toBe(true);
  });

  it.each([
    "",
    "nothing",
    "a@gmailcom",
    "a@gmail.",
    "a b@gmail.com",
    "a@@gmail.com",
    "a@gmail.com,b@gmail.com",
    "a@gmail.com;b@gmail.com",
    "Name <a@gmail.com>",
    `${"a".repeat(250)}@gmail.com`,
  ])("refuses %j", (address) => {
    expect(isValidEmail(address)).toBe(false);
  });
});

describe("replaceEmailInFormData", () => {
  it("swaps every copy of the old address, whatever the field is called", () => {
    expect(
      replaceEmailInFormData(
        { email: "a@gmail.con", custom_email_123: "A@Gmail.con ", name_en: "A" },
        "a@gmail.con",
        "a@gmail.com",
      ),
    ).toEqual({ email: "a@gmail.com", custom_email_123: "a@gmail.com", name_en: "A" });
  });

  it("leaves another person's address alone", () => {
    expect(
      replaceEmailInFormData(
        { email: "a@gmail.con", custom_email_1: "guardian@gmail.com" },
        "a@gmail.con",
        "a@gmail.com",
      ),
    ).toEqual({ email: "a@gmail.com", custom_email_1: "guardian@gmail.com" });
  });

  it("copes with an order that has no saved answers", () => {
    expect(replaceEmailInFormData(null, "a@gmail.con", "a@gmail.com")).toEqual({});
  });
});
