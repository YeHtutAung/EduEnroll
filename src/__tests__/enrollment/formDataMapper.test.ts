import { describe, it, expect } from "vitest";
import { buildEnrollmentUpdatePayload } from "@/server/enrollment/formDataMapper";

describe("buildEnrollmentUpdatePayload", () => {
  it("maps name_en when field type is text", () => {
    const result = buildEnrollmentUpdatePayload(
      { name_en: "  Aung Ko  " },
      new Map([["name_en", "text"]]),
    );
    expect(result.student_name_en).toBe("Aung Ko");
  });

  it("does not map name_en when field type does not match", () => {
    const result = buildEnrollmentUpdatePayload(
      { name_en: "Aung Ko" },
      new Map([["name_en", "select"]]),
    );
    expect(result.student_name_en).toBeUndefined();
  });

  it("falls back to resolvePhoneFromFormData for non-standard phone field", () => {
    const result = buildEnrollmentUpdatePayload(
      { phone_number: "09123456789" },
      new Map(),
    );
    // resolvePhoneFromFormData handles phone_number key
    expect(result.phone).toBeTruthy();
  });

  it("sets messenger_psid when provided", () => {
    const result = buildEnrollmentUpdatePayload(
      { name_en: "Test" },
      new Map([["name_en", "text"]]),
      "psid-123",
    );
    expect(result.messenger_psid).toBe("psid-123");
  });

  it("does not set messenger_psid when empty string", () => {
    const result = buildEnrollmentUpdatePayload({ name_en: "Test" }, new Map(), "  ");
    expect(result.messenger_psid).toBeUndefined();
  });

  it("always includes form_data", () => {
    const fd = { name_en: "Test" };
    const result = buildEnrollmentUpdatePayload(fd, new Map());
    expect(result.form_data).toBe(fd);
  });
});
