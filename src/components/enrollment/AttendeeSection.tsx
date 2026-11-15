"use client";

import { useRef } from "react";
import {
  attendeeLabel,
  attendeeTotals,
  slotKey,
  type AttendeeField,
  type AttendeeSlot,
} from "@/lib/enrollment/attendees";

// ─── Runner cards ───────────────────────────────────────────────────────────
//
// The questions an organiser asks once per ticket (runner name, jersey size…),
// one card per ticket. Each page passes its own field renderer, so a size
// field still draws as SizePicker and inputs keep the page's look.
//
// A finished card that isn't open collapses to one line ("Ma Su · M"); the
// open card shows its fields. With a single ticket there is no card chrome at
// all — the questions look like any other field on the form.
//
// Radio groups need a unique name per card, so the field handed to
// renderField carries field_key `${field_key}__r${n}`; answers are still
// stored under the real field_key.

export interface AttendeeCardSlot extends AttendeeSlot {
  /** Tier name shown on the card, e.g. "Early Bird - 10KM". */
  tierLabel: string;
}

export default function AttendeeSection<F extends AttendeeField>({
  slots,
  fields,
  values,
  errors,
  openKey,
  onOpen,
  onChange,
  renderField,
  accentColor = "#0f1f42",
}: {
  slots: AttendeeCardSlot[];
  fields: F[];
  /** slotKey → field_key → answer */
  values: Record<string, Record<string, string>>;
  /** slotKey → field_key → message (shown once the buyer has tried to continue) */
  errors: Record<string, Record<string, string>>;
  openKey: string | null;
  onOpen: (key: string) => void;
  onChange: (slotKey: string, fieldKey: string, value: string) => void;
  renderField: (field: F, value: string, onChange: (v: string) => void, error?: string) => React.ReactNode;
  accentColor?: string;
}) {
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  if (slots.length === 0 || fields.length === 0) return null;

  const fieldsFor = (key: string, n: number) =>
    fields.map((f) => (
      <div key={f.field_key}>
        {renderField(
          { ...f, field_key: `${f.field_key}__r${n}` },
          values[key]?.[f.field_key] ?? "",
          (v) => onChange(key, f.field_key, v),
          errors[key]?.[f.field_key],
        )}
      </div>
    ));

  // One ticket: the questions are simply part of the form.
  if (slots.length === 1) {
    const key = slotKey(slots[0]);
    return <>{fieldsFor(key, 1)}</>;
  }

  const isComplete = (key: string) =>
    fields.every((f) => !f.is_required || (values[key]?.[f.field_key] ?? "").trim() !== "") && !errors[key];
  const done = slots.filter((s) => isComplete(slotKey(s))).length;

  function openNext(fromIndex: number) {
    const next = slots.slice(fromIndex + 1).find((s) => !isComplete(slotKey(s)));
    if (next) {
      const key = slotKey(next);
      onOpen(key);
      requestAnimationFrame(() => cardRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } else {
      onOpen("");
    }
  }

  return (
    <section className="mb-6" aria-label="Runner details">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-gray-900">
          Runner details / <span className="font-myanmar">ပြေးသူ အချက်အလက်</span>
        </h3>
        <span className="text-xs text-gray-500">
          {done} of {slots.length} done
        </span>
      </div>

      <div className="space-y-3">
        {slots.map((slot, i) => {
          const key = slotKey(slot);
          const complete = isComplete(key);
          const hasError = !!errors[key];
          const open = openKey === key;
          const summary = attendeeLabel(values[key] ?? {}, fields);

          return (
            <div
              key={key}
              ref={(el) => {
                cardRefs.current[key] = el;
              }}
              className="rounded-xl border bg-white"
              style={{ borderColor: hasError ? "#dc2626" : open ? accentColor : "#e5e7eb" }}
            >
              <button
                type="button"
                onClick={() => onOpen(open ? "" : key)}
                aria-expanded={open}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-gray-900">
                    Runner {i + 1} · {slot.tierLabel}
                  </span>
                  {!open && (
                    <span className={`block truncate text-xs ${hasError ? "text-red-600" : "text-gray-500"}`}>
                      {hasError ? "Some details are missing" : summary || "Not filled in yet"}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs font-medium" style={{ color: complete ? "#15803d" : "#6b7280" }}>
                  {complete ? "✓ Done" : open ? "" : "Fill in"}
                </span>
              </button>

              {open && (
                <div className="border-t border-gray-100 px-4 pt-4">
                  {fieldsFor(key, i + 1)}
                  {i < slots.length - 1 && (
                    <button
                      type="button"
                      onClick={() => openNext(i)}
                      className="mb-4 w-full rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700"
                    >
                      Next runner →
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** "Jerseys in this order" rows for the review step: counts per option, in option order. */
export function AttendeeTotals<F extends AttendeeField>({
  fields,
  values,
  slots,
}: {
  fields: F[];
  values: Record<string, Record<string, string>>;
  slots: AttendeeSlot[];
}) {
  const choiceFields = fields.filter((f) => f.field_type === "select" || f.field_type === "radio");
  if (slots.length < 2 || choiceFields.length === 0) return null;

  return (
    <>
      {choiceFields.map((f) => {
        const rows = attendeeTotals(
          slots.map((s) => ({ answers: values[slotKey(s)] ?? {} })),
          f,
        ).map((t) => [t.value, t.count] as const);
        if (rows.length === 0) return null;
        return (
          <div key={f.field_key} className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {f.field_label} in this order
            </h3>
            <dl className="space-y-1.5 text-sm">
              {rows.map(([value, count]) => (
                <div key={value} className="flex justify-between">
                  <dt className="text-gray-700">{value}</dt>
                  <dd className="font-medium text-gray-900">{count}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </>
  );
}
