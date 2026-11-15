import { describe, expect, it, vi } from "vitest";
import { checkAttendees, loadAttendeeContext, normaliseQuantity } from "@/server/enrollment/attendeeContext";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, unknown>;

/**
 * A thenable query builder per table: every filter returns the builder, and
 * awaiting it resolves to the table's canned result. Records the tables read.
 */
function fakeSupabase(tables: Record<string, { data: Row[] | null; error: unknown }>) {
  const reads: string[] = [];
  const from = vi.fn((table: string) => {
    reads.push(table);
    const result = tables[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "in", "eq", "order"]) builder[m] = () => builder;
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return builder;
  });
  return { client: { from }, reads };
}

const NAME = { field_key: "runner_name", field_label: "Runner Name", field_type: "text", is_required: true, options: null, intake_id: "i1" };
const SIZE = { field_key: "jersey", field_label: "Jersey Size", field_type: "select", is_required: true, options: ["S", "M"], intake_id: "i1" };

describe("normaliseQuantity", () => {
  it("matches createEnrollment: floor, minimum 1, non-numbers become 1", () => {
    expect(normaliseQuantity(2.7)).toBe(2);
    expect(normaliseQuantity(0)).toBe(1);
    expect(normaliseQuantity(-3)).toBe(1);
    expect(normaliseQuantity("3")).toBe(1);
    expect(normaliseQuantity(undefined)).toBe(1);
  });
});

describe("loadAttendeeContext", () => {
  it("returns no fields and no slots for an event without per-ticket fields", async () => {
    const { client } = fakeSupabase({
      classes: { data: [{ id: A, intake_id: "i1", pack_size: 1 }], error: null },
      intake_form_fields: { data: [], error: null },
    });
    const ctx = await loadAttendeeContext(client, [{ class_id: A, quantity: 1e9 }]);
    expect(ctx).toEqual({ ok: true, fields: [], slots: [] });
  });

  it("makes one slot per admission, quantity × pack_size", async () => {
    const { client } = fakeSupabase({
      classes: { data: [{ id: A, intake_id: "i1", pack_size: 2 }, { id: B, intake_id: "i1", pack_size: null }], error: null },
      intake_form_fields: { data: [NAME, SIZE], error: null },
    });
    const ctx = await loadAttendeeContext(client, [{ class_id: A, quantity: 1 }, { class_id: B, quantity: 0 }]);
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.slots).toEqual([{ class_id: A, seat_no: 1 }, { class_id: A, seat_no: 2 }, { class_id: B, seat_no: 1 }]);
      expect(ctx.fields.map((f) => f.field_key)).toEqual(["runner_name", "jersey"]);
    }
  });

  it("refuses a huge quantity without building slots", async () => {
    const { client } = fakeSupabase({
      classes: { data: [{ id: A, intake_id: "i1", pack_size: 1 }], error: null },
      intake_form_fields: { data: [NAME], error: null },
    });
    const ctx = await loadAttendeeContext(client, [{ class_id: A, quantity: 1e9 }]);
    expect(ctx).toEqual({ ok: false, message: "Too many tickets in one order." });
  });

  it("refuses a non-UUID class id without querying", async () => {
    const { client, reads } = fakeSupabase({});
    const ctx = await loadAttendeeContext(client, [{ class_id: "nope", quantity: 1 }]);
    expect(ctx.ok).toBe(false);
    expect(reads).toEqual([]);
  });

  it("refuses a class that does not exist", async () => {
    const { client } = fakeSupabase({ classes: { data: [], error: null } });
    const ctx = await loadAttendeeContext(client, [{ class_id: A, quantity: 1 }]);
    expect(ctx.ok).toBe(false);
  });

  it("refuses a cart spanning two events when either asks per-ticket questions", async () => {
    const { client } = fakeSupabase({
      classes: { data: [{ id: A, intake_id: "i1", pack_size: 1 }, { id: B, intake_id: "i2", pack_size: 1 }], error: null },
      intake_form_fields: { data: [NAME], error: null },
    });
    const ctx = await loadAttendeeContext(client, [{ class_id: A, quantity: 1 }, { class_id: B, quantity: 1 }]);
    expect(ctx).toEqual({ ok: false, message: "Buy tickets for one event at a time." });
  });

  it("throws when a query fails", async () => {
    const { client } = fakeSupabase({ classes: { data: null, error: { message: "boom" } } });
    await expect(loadAttendeeContext(client, [{ class_id: A, quantity: 1 }])).rejects.toThrow();
  });
});

describe("checkAttendees", () => {
  it("validates the runners against the loaded slots and fields", async () => {
    const { client } = fakeSupabase({
      classes: { data: [{ id: A, intake_id: "i1", pack_size: 1 }], error: null },
      intake_form_fields: { data: [NAME, SIZE], error: null },
    });
    const ok = await checkAttendees(client, [{ class_id: A, quantity: 1 }], [
      { class_id: A, seat_no: 1, answers: { runner_name: "Ko Aung", jersey: "M" } },
    ]);
    expect(ok).toEqual({
      ok: true,
      attendees: [{ class_id: A, seat_no: 1, answers: { runner_name: "Ko Aung", jersey: "M" }, label: "Ko Aung · M" }],
    });
    const bad = await checkAttendees(client, [{ class_id: A, quantity: 1 }], undefined);
    expect(bad.ok).toBe(false);
  });

  it("passes the context's own refusal through", async () => {
    const { client } = fakeSupabase({});
    const r = await checkAttendees(client, [{ class_id: "nope", quantity: 1 }], []);
    expect(r.ok).toBe(false);
  });
});
