// ─── Size chart on an organiser's size field ─────────────────────────────────
//
// Some organisers ask buyers for a jersey or T-shirt size. For those listed
// below, the public forms draw that field as size buttons with a "View size
// chart" link instead of a dropdown.
//
// The match is by tenant subdomain and field label, not field_key: a field
// created in the form editor gets a generated key that differs between the dev
// and production databases. The server decides the match (GET
// /api/public/form-fields adds `size_chart_url` to the field), so the browser
// never has to work out which tenant it is on.
//
// The answer saved is unchanged: the option text exactly as the organiser
// typed it (for example "Kids 6"), same as the dropdown would have saved.

interface SizeChartConfig {
  /** Field label as typed in the form editor; compared trimmed, case-insensitive. */
  fieldLabel: string;
  /** Image under /public. */
  imageUrl: string;
}

const SIZE_CHARTS: Record<string, SizeChartConfig[]> = {
  // The Beats Run — organiser's chart for The Beats Run 2026, requested 2026-11-06.
  beatsrun: [{ fieldLabel: "Jersey Size", imageUrl: "/tenants/beatsrun/size-chart.webp" }],
};

/** Field types whose answer is one of `options`, so size buttons can stand in. */
const CHOICE_TYPES = new Set(["select", "radio"]);

export function sizeChartUrlFor(
  tenantSlug: string | null | undefined,
  field: { field_label: string; field_type: string; options: unknown },
): string | null {
  if (!tenantSlug) return null;
  if (!CHOICE_TYPES.has(field.field_type)) return null;
  if (!Array.isArray(field.options) || field.options.length === 0) return null;
  const label = field.field_label.trim().toLowerCase();
  const match = SIZE_CHARTS[tenantSlug.toLowerCase()]?.find(
    (c) => c.fieldLabel.trim().toLowerCase() === label,
  );
  return match?.imageUrl ?? null;
}

export interface SizeOption {
  /** Saved answer — the organiser's option text, unchanged. */
  value: string;
  /** Text on the button. */
  label: string;
}

const KIDS_PREFIX = /^(kids?|baby|child(ren)?)\b[\s:-]*/i;

/**
 * Splits options into a kids row and an adult row, keeping the organiser's
 * order within each. An option is a kids size when it starts with "Kid",
 * "Kids", "Baby" or "Child" (the button drops that word: "Kids 6" → "6"), or
 * when it is a bare number such as an age ("6", "10").
 */
export function groupSizeOptions(options: string[]): { kids: SizeOption[]; adult: SizeOption[] } {
  const kids: SizeOption[] = [];
  const adult: SizeOption[] = [];
  for (const value of options) {
    const trimmed = value.trim();
    const stripped = trimmed.replace(KIDS_PREFIX, "");
    if (stripped !== trimmed && stripped !== "") {
      kids.push({ value, label: stripped });
    } else if (/^\d+(\.\d+)?$/.test(trimmed)) {
      kids.push({ value, label: trimmed });
    } else {
      adult.push({ value, label: trimmed });
    }
  }
  return { kids, adult };
}
