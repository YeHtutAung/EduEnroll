"use client";

import { useEffect, useState } from "react";
import { groupSizeOptions, type SizeOption } from "@/lib/enrollment/sizeChart";

// Size buttons plus a "View size chart" link, standing in for a size dropdown
// on the public forms. Only drawn for fields the server marked with
// `size_chart_url` (see @/lib/enrollment/sizeChart).
//
// The buttons are real radio inputs (visually hidden, not display:none), so
// `required` still stops the form from submitting without a size and the
// browser's own "please select one" message still points at them.

const NAVY = "#0f1f42";
const IDLE_BORDER = "#d8d5c9";
const MUTED = "#9a9484";

export default function SizePicker({
  name,
  label,
  options,
  value,
  onChange,
  required,
  chartUrl,
  labelClassName,
  labelStyle,
  requiredMark,
}: {
  /** Radio group name — the field_key. */
  name: string;
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
  required: boolean;
  chartUrl: string;
  /** Lets each page keep its own label look. */
  labelClassName?: string;
  labelStyle?: React.CSSProperties;
  /** Shown after the label, e.g. a red asterisk or "(optional)". */
  requiredMark?: React.ReactNode;
}) {
  const [chartOpen, setChartOpen] = useState(false);
  const { kids, adult } = groupSizeOptions(options);
  const selected = [...kids, ...adult].find((o) => o.value === value);

  useEffect(() => {
    if (!chartOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChartOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [chartOpen]);

  // Only one radio of a group needs `required`; marking the first keeps the
  // browser's message on the group's first button.
  let firstRendered = false;
  const renderRow = (rowLabel: string | null, row: SizeOption[]) => {
    if (row.length === 0) return null;
    return (
      <div>
        {rowLabel && (
          <p className="text-[11px] mb-1.5 mt-2" style={{ color: MUTED }}>{rowLabel}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {row.map((o) => {
            const isOn = o.value === value;
            const markRequired = required && !firstRendered;
            firstRendered = true;
            return (
              <label
                key={o.value}
                className="relative inline-flex items-center justify-center min-w-[44px] h-[38px] px-2.5 rounded-[7px] text-[13px] font-semibold cursor-pointer select-none focus-within:ring-2 focus-within:ring-offset-1"
                style={{
                  border: `1.5px solid ${isOn ? NAVY : IDLE_BORDER}`,
                  background: isOn ? NAVY : "#ffffff",
                  color: isOn ? "#ffffff" : NAVY,
                  // Tailwind ring colour from a hex we don't keep in config.
                  ["--tw-ring-color" as string]: "rgba(15,31,66,.35)",
                }}
              >
                <input
                  type="radio"
                  name={name}
                  value={o.value}
                  checked={isOn}
                  onChange={() => onChange(o.value)}
                  required={markRequired}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  aria-label={o.value}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      </div>
    );
  };

  const hasBothRows = kids.length > 0 && adult.length > 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className={labelClassName} style={labelStyle}>
          {label}
          {requiredMark}
        </span>
        <button
          type="button"
          onClick={() => setChartOpen(true)}
          className="shrink-0 text-[12px] font-semibold underline underline-offset-2"
          style={{ color: NAVY }}
        >
          View size chart
        </button>
      </div>

      <div role="radiogroup" aria-label={label}>
        {renderRow(hasBothRows ? "Kids (age)" : null, kids)}
        {renderRow(hasBothRows ? "Adult" : null, adult)}
      </div>

      <p className="text-[11px] mt-2" style={{ color: MUTED }}>
        {selected ? `Selected: ${selected.value}` : "Choose a size"}
      </p>

      {chartOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${label} chart`}
          className="fixed inset-0 z-50 flex flex-col"
          style={{ background: "#0b0b0b" }}
          onClick={() => setChartOpen(false)}
        >
          <div className="flex items-center justify-between px-4 py-3 text-white">
            <span className="text-[14px] font-bold">Size chart</span>
            <button
              type="button"
              aria-label="Close size chart"
              onClick={() => setChartOpen(false)}
              className="w-9 h-9 flex items-center justify-center rounded-full text-[22px] leading-none"
              style={{ background: "rgba(255,255,255,.12)" }}
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-auto flex items-center justify-center p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={chartUrl}
              alt={`${label} chart`}
              className="max-w-full max-h-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <p className="text-center text-[11px] pb-4" style={{ color: "#bbbbbb" }}>
            Pinch to zoom · tap outside to close
          </p>
        </div>
      )}
    </div>
  );
}
