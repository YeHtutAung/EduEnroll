import { describe, expect, it } from "vitest";
import {
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
    "a@email.com",
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
