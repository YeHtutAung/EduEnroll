// ─── Complimentary ticket list ──────────────────────────────────────────────
//
// Pure checks for scripts/issue-complimentary-tickets.ts: reads the organiser's
// list (CSV) and turns each line into one free ticket to create. Nothing is
// guessed: a size that is not exactly one of the event's choices, a tier that
// is not mapped, or a repeated email stops the whole run, so the operator fixes
// the list rather than the script deciding for them.

export interface ComplimentaryRow {
  /** 1-based line number in the CSV, header included, for error messages. */
  line: number;
  name: string;
  phone: string;
  email: string;
  /** The distance as written in the list, e.g. "10KM". */
  distance: string;
  /** classes.level the ticket is issued on. */
  tierLevel: string;
  /** One of the event's size choices, in its own spelling. */
  size: string;
}

export type RowsResult = { ok: true; rows: ComplimentaryRow[] } | { ok: false; errors: string[] };

const REQUIRED = ["name", "phone", "email", "distance", "size"] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Myanmar mobile numbers: 09 + 7 to 9 digits, or the same with +95 / 959.
const PHONE_RE = /^(09|\+?959)\d{7,9}$/;

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF, a BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Blank lines (a trailing newline, a spreadsheet's empty rows) carry nothing.
  return records.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Strips the spaces, dashes and dots people type into phone numbers. */
export function normalisePhone(raw: string): string {
  return raw.replace(/[\s\-.()]/g, "");
}

/**
 * Checks every line and returns either all rows or every problem found.
 *
 * @param tiers distance (any case) → classes.level, from the --tier options
 * @param sizes the event's jersey size choices
 */
export function parseComplimentaryRows(
  records: string[][],
  tiers: Map<string, string>,
  sizes: string[],
): RowsResult {
  if (records.length === 0) return { ok: false, errors: ["The list is empty."] };

  const header = records[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    return { ok: false, errors: [`Missing column(s): ${missing.join(", ")}. Expected: ${REQUIRED.join(", ")}.`] };
  }
  const col = (r: string[], name: string) => (r[header.indexOf(name)] ?? "").trim();

  const tierByDistance = new Map(Array.from(tiers.entries()).map(([d, level]) => [d.trim().toLowerCase(), level]));
  const sizeByLower = new Map(sizes.map((s) => [s.toLowerCase(), s]));

  const errors: string[] = [];
  const rows: ComplimentaryRow[] = [];
  const seenEmail = new Map<string, number>();

  records.slice(1).forEach((r, i) => {
    const line = i + 2;
    const name = col(r, "name").replace(/\s+/g, " ");
    const phone = normalisePhone(col(r, "phone"));
    const email = col(r, "email").toLowerCase();
    const distance = col(r, "distance");
    const sizeRaw = col(r, "size");

    const problems: string[] = [];
    if (!name) problems.push("name is empty");
    if (name.length > 200) problems.push("name is too long");
    if (!PHONE_RE.test(phone)) problems.push(`phone "${col(r, "phone")}" is not a Myanmar mobile number`);
    if (!EMAIL_RE.test(email)) problems.push(`email "${col(r, "email")}" is not an email address`);
    const tierLevel = tierByDistance.get(distance.toLowerCase());
    if (!tierLevel) problems.push(`distance "${distance}" has no --tier mapping`);
    const size = sizeByLower.get(sizeRaw.toLowerCase());
    if (!size) problems.push(`size "${sizeRaw}" is not one of: ${sizes.join(", ")}`);

    const firstLine = seenEmail.get(email);
    if (email && firstLine !== undefined) problems.push(`email repeats line ${firstLine}`);
    else if (email) seenEmail.set(email, line);

    if (problems.length) {
      errors.push(`Line ${line}: ${problems.join("; ")}`);
      return;
    }
    rows.push({ line, name, phone, email, distance, tierLevel: tierLevel!, size: size! });
  });

  if (errors.length) return { ok: false, errors };
  if (rows.length === 0) return { ok: false, errors: ["The list has a header but no people."] };
  return { ok: true, rows };
}

/**
 * The order's idempotency key: one complimentary ticket per email per event,
 * so a re-run finds the order it made instead of making a second one. The
 * "comp:" prefix also tells these orders apart from bought ones.
 */
export function complimentaryKey(intakeId: string, email: string): string {
  return `comp:${intakeId}:${email.toLowerCase()}`;
}
