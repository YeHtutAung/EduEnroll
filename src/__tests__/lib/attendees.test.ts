import { describe, expect, it } from "vitest";
import {
  attendeeSlots,
  validateAttendees,
  attendeeLabel,
  attendeeTotals,
  MAX_ATTENDEES,
  perAttendeeProblem,
  slotKey,
  attendeeFieldErrors,
  attendeesPayload,
  runnerRows,
  orderTotals,
  type AttendeeField,
} from "@/lib/enrollment/attendees";

const NAME: AttendeeField = { field_key: "runner_name", field_label: "Runner Name", field_type: "text", is_required: true, options: null };
const SIZE: AttendeeField = { field_key: "jersey", field_label: "Jersey Size", field_type: "select", is_required: true, options: ["Kids 8", "S", "M"] };
const FIELDS = [NAME, SIZE];
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("attendeeSlots", () => {
  it("numbers seats 1..N per class, summing duplicate lines, in first-seen order", () => {
    expect(attendeeSlots([{ class_id: A, admissions: 1 }, { class_id: B, admissions: 1 }, { class_id: A, admissions: 1 }]))
      .toEqual([{ class_id: A, seat_no: 1 }, { class_id: A, seat_no: 2 }, { class_id: B, seat_no: 1 }]);
  });

  it("refuses an order with more admissions than MAX_ATTENDEES", () => {
    expect(() => attendeeSlots([{ class_id: A, admissions: MAX_ATTENDEES + 1 }])).toThrow(/too many/i);
    expect(() => attendeeSlots([{ class_id: A, admissions: Number.POSITIVE_INFINITY }])).toThrow(/too many/i);
  });
});

describe("validateAttendees", () => {
  const slots = [{ class_id: A, seat_no: 1 }, { class_id: B, seat_no: 1 }];
  const good = [
    { class_id: A, seat_no: 1, answers: { runner_name: " Ko Aung ", jersey: "M" } },
    { class_id: B, seat_no: 1, answers: { runner_name: "Ma Su", jersey: "Kids 8" } },
  ];

  it("accepts one entry per slot, trims answers and fixes each runner's label", () => {
    const r = validateAttendees(good, slots, FIELDS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attendees[0].answers.runner_name).toBe("Ko Aung");
      expect(r.attendees[1].label).toBe("Ma Su · Kids 8");
    }
  });

  it("returns an empty list when there are no per-ticket fields, whatever was sent", () => {
    expect(validateAttendees(good, slots, [])).toEqual({ ok: true, attendees: [] });
  });

  it("tells a buyer with a stale page to reload", () => {
    const r = validateAttendees(undefined, slots, FIELDS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/reload/i);
  });

  it("rejects a missing runner", () => {
    expect(validateAttendees(good.slice(0, 1), slots, FIELDS).ok).toBe(false);
  });

  it("rejects an entry for a seat that does not exist", () => {
    const bad = [good[0], { ...good[1], seat_no: 2 }];
    expect(validateAttendees(bad, slots, FIELDS).ok).toBe(false);
  });

  it("rejects a required answer left empty, naming the runner", () => {
    const bad = [good[0], { ...good[1], answers: { runner_name: "  ", jersey: "S" } }];
    const r = validateAttendees(bad, slots, FIELDS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Runner 2/);
  });

  it("rejects a size that is not one of the options", () => {
    const bad = [good[0], { ...good[1], answers: { runner_name: "Ma Su", jersey: "XXXL" } }];
    expect(validateAttendees(bad, slots, FIELDS).ok).toBe(false);
  });

  it("drops keys that are not per-ticket fields", () => {
    const extra = [{ ...good[0], answers: { ...good[0].answers, email: "x@y.z" } }, good[1]];
    const r = validateAttendees(extra, slots, FIELDS);
    expect(r.ok).toBe(true);
    if (r.ok) expect("email" in r.attendees[0].answers).toBe(false);
  });

  it("rejects a non-array, a malformed entry and over-long answers", () => {
    expect(validateAttendees("nope", slots, FIELDS).ok).toBe(false);
    expect(validateAttendees([null, good[1]], slots, FIELDS).ok).toBe(false);
    expect(validateAttendees([{ ...good[0], seat_no: "1" }, good[1]], slots, FIELDS).ok).toBe(false);
    const long = [{ ...good[0], answers: { runner_name: "x".repeat(201), jersey: "M" } }, good[1]];
    expect(validateAttendees(long, slots, FIELDS).ok).toBe(false);
  });

  it("rejects the same seat sent twice in place of another", () => {
    expect(validateAttendees([good[0], good[0]], slots, FIELDS).ok).toBe(false);
  });

  it("allows an optional answer to be left out", () => {
    const optional = [NAME, { ...SIZE, is_required: false }];
    const r = validateAttendees([good[0], { ...good[1], answers: { runner_name: "Ma Su" } }], slots, optional);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attendees[1]).toEqual({ class_id: B, seat_no: 1, answers: { runner_name: "Ma Su" }, label: "Ma Su" });
  });
});

describe("attendeeLabel", () => {
  it("joins answers in field order", () => {
    expect(attendeeLabel({ runner_name: "Ma Su", jersey: "Kids 8" }, FIELDS)).toBe("Ma Su · Kids 8");
  });
  it("skips empty optional answers", () => {
    expect(attendeeLabel({ runner_name: "Ma Su" }, FIELDS)).toBe("Ma Su");
  });
});

describe("attendeeTotals", () => {
  it("counts each option of a choice field, in option order", () => {
    const list = [{ answers: { jersey: "M" } }, { answers: { jersey: "M" } }, { answers: { jersey: "S" } }];
    expect(attendeeTotals(list, SIZE)).toEqual([{ value: "S", count: 1 }, { value: "M", count: 2 }]);
  });
  it("puts values no longer in the option list last", () => {
    const list = [{ answers: { jersey: "XS" } }, { answers: { jersey: "M" } }];
    expect(attendeeTotals(list, SIZE).map((t) => t.value)).toEqual(["M", "XS"]);
  });
});

describe("perAttendeeProblem", () => {
  it("allows the one-string types on a custom field", () => {
    for (const t of ["text", "select", "radio", "date", "phone"]) {
      expect(perAttendeeProblem({ field_type: t, is_default: false })).toBeNull();
    }
  });
  it("refuses contact fields", () => {
    expect(perAttendeeProblem({ field_type: "text", is_default: true })).toMatch(/once per order/);
  });
  it("refuses file, checkbox, email and address", () => {
    for (const t of ["file", "checkbox", "email", "address"]) {
      expect(perAttendeeProblem({ field_type: t, is_default: false })).toMatch(/can't be asked per ticket/);
    }
  });
});

describe("runner card helpers", () => {
  const slots = [{ class_id: A, seat_no: 1 }, { class_id: A, seat_no: 2 }];

  it("keys a slot as class_id:seat_no", () => {
    expect(slotKey({ class_id: A, seat_no: 2 })).toBe(`${A}:2`);
  });

  it("lists every missing or invalid answer per card", () => {
    const errors = attendeeFieldErrors({ [`${A}:1`]: { runner_name: "Ko Aung", jersey: "XXL" } }, slots, FIELDS);
    expect(errors).toEqual({
      [`${A}:1`]: { jersey: "Choose a Jersey Size from the list." },
      [`${A}:2`]: { runner_name: "Runner Name is required.", jersey: "Jersey Size is required." },
    });
  });

  it("has no errors when every card is complete", () => {
    const values = { [`${A}:1`]: { runner_name: "A", jersey: "S" }, [`${A}:2`]: { runner_name: "B", jersey: "M" } };
    expect(attendeeFieldErrors(values, slots, FIELDS)).toEqual({});
  });

  it("builds the payload the server validates, trimmed, in slot order", () => {
    const values = { [`${A}:2`]: { runner_name: " B ", jersey: "M" }, [`${A}:1`]: { runner_name: "A", jersey: "", other: "x" } };
    const payload = attendeesPayload(values, slots, FIELDS);
    expect(payload).toEqual([
      { class_id: A, seat_no: 1, answers: { runner_name: "A" } },
      { class_id: A, seat_no: 2, answers: { runner_name: "B", jersey: "M" } },
    ]);
    const optionalSize = [NAME, { ...SIZE, is_required: false }];
    expect(validateAttendees(payload, slots, optionalSize).ok).toBe(true);
  });
});

describe("runnerRows", () => {
  it("returns stored runners in seat order with their tier", () => {
    const rows = runnerRows(
      [
        { class_id: B, seat_no: 1, label: "C · S", answers: { runner_name: "C", jersey: "S" } },
        { class_id: A, seat_no: 2, label: "B · M", answers: { runner_name: "B", jersey: "M" } },
        { class_id: A, seat_no: 1, label: "A · M", answers: { runner_name: "A", jersey: "M" } },
      ],
      (id) => (id === A ? "10KM" : "5KM"),
    );
    expect(rows.map((r) => `${r.tier} ${r.seat_no} ${r.label}`)).toEqual(["10KM 1 A · M", "10KM 2 B · M", "5KM 1 C · S"]);
  });
  it("skips malformed entries and non-arrays", () => {
    expect(runnerRows(null, () => "")).toEqual([]);
    expect(runnerRows([null, "x", { class_id: A, seat_no: "1", answers: {} }, { class_id: A, seat_no: 1, answers: [] }], () => "")).toEqual([]);
  });
});

describe("orderTotals", () => {
  it("counts runners, and orders from before the switch once from form_data", () => {
    const orders: { attendees: unknown; form_data: Record<string, string> | null }[] = [
      { attendees: [
        { class_id: A, seat_no: 1, label: "", answers: { jersey: "M" } },
        { class_id: A, seat_no: 2, label: "", answers: { jersey: "Kids 8" } },
      ], form_data: { jersey: "S" } },
      { attendees: [], form_data: { jersey: "M" } },
      { attendees: [], form_data: {} },
      { attendees: [], form_data: null },
    ];
    expect(orderTotals(orders, SIZE)).toEqual([{ value: "Kids 8", count: 1 }, { value: "M", count: 2 }]);
  });

  it("falls back per field: runners with only a name still count the order's size", () => {
    const orders: { attendees: unknown; form_data: Record<string, string> | null }[] = [
      { attendees: [{ class_id: A, seat_no: 1, label: "Ko Aung", answers: { runner_name: "Ko Aung" } }], form_data: { jersey: "M" } },
    ];
    expect(orderTotals(orders, SIZE)).toEqual([{ value: "M", count: 1 }]);
  });
});
