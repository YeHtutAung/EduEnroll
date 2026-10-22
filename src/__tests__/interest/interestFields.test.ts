import { describe, it, expect } from "vitest";
import {
  FORM_DATA_MAX_BYTES,
  INTEREST_ANSWER_MAX,
  interestCustomFields,
  jsonbTextBytes,
  validateInterestFormData,
  type InterestFieldDef,
} from "@/lib/interest/interestFields";

const field = (over: Partial<InterestFieldDef> = {}): InterestFieldDef => ({
  field_key: "tshirt",
  field_label: "T-shirt size",
  field_type: "select",
  is_required: true,
  options: ["S", "M", "L"],
  is_default: false,
  ...over,
});

const DEFAULTS: InterestFieldDef[] = [
  field({ field_key: "name_en", field_label: "Name (English)", field_type: "text", is_default: true, options: null }),
  field({ field_key: "nrc", field_label: "NRC Number", field_type: "text", is_default: true, options: null }),
  field({ field_key: "phone", field_label: "Phone Number", field_type: "phone", is_default: true, options: null }),
];

describe("interestCustomFields", () => {
  it("keeps custom fields and drops default and file fields", () => {
    const fields = [
      ...DEFAULTS,
      field(),
      field({ field_key: "photo", field_label: "Photo", field_type: "file", options: null }),
    ];
    expect(interestCustomFields(fields).map((f) => f.field_key)).toEqual(["tshirt"]);
  });
});

describe("validateInterestFormData", () => {
  it("accepts a valid dropdown answer and trims it", () => {
    const r = validateInterestFormData([field()], { tshirt: " M " });
    expect(r).toEqual({ ok: true, data: { tshirt: "M" } });
  });

  it("rejects a missing required answer, naming the field", () => {
    const r = validateInterestFormData([field()], {});
    expect(r).toEqual({ ok: false, message: "T-shirt size is required." });
  });

  it("treats an absent form_data as no answers", () => {
    expect(validateInterestFormData([field({ is_required: false })], undefined)).toEqual({
      ok: true,
      data: {},
    });
    expect(validateInterestFormData([field()], null).ok).toBe(false);
  });

  it("rejects a dropdown or radio answer that is not one of the options", () => {
    expect(validateInterestFormData([field()], { tshirt: "XXL" }).ok).toBe(false);
    expect(
      validateInterestFormData([field({ field_type: "radio" })], { tshirt: "XXL" }).ok,
    ).toBe(false);
  });

  it("does not trust non-array options", () => {
    const r = validateInterestFormData([field({ options: { S: true } })], { tshirt: "S" });
    expect(r.ok).toBe(false);
  });

  it("drops keys that are not a shown custom field", () => {
    // A caller must not be able to write arbitrary keys, or answers for the
    // default fields the form does not show.
    const r = validateInterestFormData([...DEFAULTS, field()], {
      tshirt: "S",
      nrc: "12/ABC(N)123456",
      injected: "x",
    });
    expect(r).toEqual({ ok: true, data: { tshirt: "S" } });
  });

  it("never reads prototype keys", () => {
    const r = validateInterestFormData(
      [field({ field_key: "constructor", field_type: "text", options: null })],
      {},
    );
    expect(r.ok).toBe(false);
  });

  it("omits empty optional answers", () => {
    const r = validateInterestFormData(
      [field({ is_required: false }), field({ field_key: "note", field_type: "text", is_required: false, options: null })],
      { tshirt: "", note: "   " },
    );
    expect(r).toEqual({ ok: true, data: {} });
  });

  it("rejects a non-string answer and a non-object form_data", () => {
    expect(validateInterestFormData([field()], { tshirt: 3 }).ok).toBe(false);
    expect(validateInterestFormData([field()], ["S"]).ok).toBe(false);
    expect(validateInterestFormData([field()], "tshirt=S").ok).toBe(false);
  });

  it("validates checkbox, date and email answers", () => {
    const cb = field({ field_key: "agree", field_label: "Agree", field_type: "checkbox", options: null });
    expect(validateInterestFormData([cb], { agree: "true" }).ok).toBe(true);
    expect(validateInterestFormData([cb], { agree: "yes" }).ok).toBe(false);

    const date = field({ field_key: "dob", field_label: "Birthday", field_type: "date", options: null });
    expect(validateInterestFormData([date], { dob: "2000-01-31" }).ok).toBe(true);
    expect(validateInterestFormData([date], { dob: "31/01/2000" }).ok).toBe(false);

    const email = field({ field_key: "alt", field_label: "Other email", field_type: "email", options: null });
    expect(validateInterestFormData([email], { alt: "a@b.co" }).ok).toBe(true);
    expect(validateInterestFormData([email], { alt: "not-an-email" }).ok).toBe(false);
  });

  it("caps a single answer and the whole object", () => {
    const text = field({ field_key: "note", field_label: "Note", field_type: "text", options: null });
    expect(validateInterestFormData([text], { note: "a".repeat(INTEREST_ANSWER_MAX) }).ok).toBe(true);
    expect(validateInterestFormData([text], { note: "a".repeat(INTEREST_ANSWER_MAX + 1) }).ok).toBe(false);

    // Myanmar text is 3 bytes per character, so enough full-length answers
    // cross the byte cap even though each is within the character cap.
    const many = Array.from({ length: 12 }, (_, i) =>
      field({ field_key: `f${i}`, field_label: `F${i}`, field_type: "text", options: null }),
    );
    const answers = Object.fromEntries(many.map((f) => [f.field_key, "က".repeat(INTEREST_ANSWER_MAX)]));
    expect(12 * INTEREST_ANSWER_MAX * 3).toBeGreaterThan(FORM_DATA_MAX_BYTES);
    expect(validateInterestFormData(many, answers)).toEqual({
      ok: false,
      message: "Your answers are too long.",
    });
  });

  it("rejects a NUL character, which PostgreSQL cannot store", () => {
    const text = field({ field_key: "note", field_label: "Note", field_type: "text", options: null });
    expect(validateInterestFormData([text], { note: "a\u0000b" }).ok).toBe(false);
  });
});

/**
 * How PostgreSQL renders jsonb as text: a space after every ':' and ','.
 * Key order differs in real jsonb (shorter keys first), which does not change
 * the size.
 */
function pgJsonbText(data: Record<string, string>): string {
  return `{${Object.entries(data)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(", ")}}`;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("jsonbTextBytes", () => {
  it("measures what the database CHECK measures", () => {
    const cases: Record<string, string>[] = [
      {},
      { a: "x" },
      { tshirt: "M", note: 'say "hi"\n\tbye \\ \u0001', mm: "မင်္ဂလာပါ" },
    ];
    for (const data of cases) expect(jsonbTextBytes(data)).toBe(bytes(pgJsonbText(data)));
  });

  it("rejects answers that fit compact JSON but not the database's jsonb text", () => {
    // The reviewer's case: 33 answers of 486 characters are 16,326 bytes as
    // JSON.stringify writes them, but 16,391 as jsonb text — over the cap.
    const fields = Array.from({ length: 33 }, (_, i) =>
      field({ field_key: `f${i}`, field_label: `F${i}`, field_type: "text", options: null }),
    );
    const answers = Object.fromEntries(fields.map((f) => [f.field_key, "a".repeat(486)]));

    expect(bytes(JSON.stringify(answers))).toBeLessThanOrEqual(FORM_DATA_MAX_BYTES);
    expect(bytes(pgJsonbText(answers))).toBeGreaterThan(FORM_DATA_MAX_BYTES);
    expect(validateInterestFormData(fields, answers)).toEqual({
      ok: false,
      message: "Your answers are too long.",
    });
  });

  it("accepts answers exactly at the cap", () => {
    // One answer whose jsonb text is exactly FORM_DATA_MAX_BYTES:
    // {"k": "<v>"} is 9 bytes of framing around the value.
    const k = field({ field_key: "k", field_label: "K", field_type: "text", options: null });
    const atCap = { k: "a".repeat(FORM_DATA_MAX_BYTES - 9) };
    expect(bytes(pgJsonbText(atCap))).toBe(FORM_DATA_MAX_BYTES);
    expect(jsonbTextBytes(atCap)).toBe(FORM_DATA_MAX_BYTES);
    expect(jsonbTextBytes({ k: "a".repeat(FORM_DATA_MAX_BYTES - 8) })).toBe(FORM_DATA_MAX_BYTES + 1);
    // The per-answer cap is what stops a single answer this long in practice.
    expect(validateInterestFormData([k], atCap).ok).toBe(false);
  });
});
