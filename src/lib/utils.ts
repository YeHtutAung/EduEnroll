import type { ClassStatus, JlptLevel } from "@/types/database";

// ─── Myanmar numeral map ──────────────────────────────────────────────────────

const MM_DIGITS: Record<string, string> = {
  "0": "၀",
  "1": "၁",
  "2": "၂",
  "3": "၃",
  "4": "၄",
  "5": "၅",
  "6": "၆",
  "7": "၇",
  "8": "၈",
  "9": "၉",
};

function toMyanmarNumerals(str: string): string {
  return str.replace(/[0-9]/g, (d) => MM_DIGITS[d]);
}

// ─── 1. Currency formatters ───────────────────────────────────────────────────

/**
 * Formats an amount in Myanmar Kyat using Myanmar numerals.
 * formatMMK(300000) → "၃၀၀,၀၀၀ MMK"
 */
export function formatMMK(amount: number): string {
  const withCommas = amount.toLocaleString("en-US"); // "300,000"
  return `${toMyanmarNumerals(withCommas)} MMK`;
}

/**
 * Formats an amount in Myanmar Kyat using standard (Arabic) numerals.
 * formatMMKSimple(300000) → "300,000 MMK"
 */
export function formatMMKSimple(amount: number): string {
  return `${amount.toLocaleString("en-US")} MMK`;
}

// ─── 2. Enrollment reference generator ───────────────────────────────────────

/**
 * Generates a client-side enrollment reference in the format "NM-YYYY-XXXXX".
 * Uses a random 5-digit number; the authoritative sequential ref is assigned
 * server-side by the SQL trigger in 005_create_enrollments.sql.
 *
 * generateEnrollmentRef() → "NM-2026-00142"
 */
export function generateEnrollmentRef(): string {
  const year = new Date().getFullYear();
  const rand = Math.floor(Math.random() * 100_000);
  const padded = String(rand).padStart(5, "0");
  return `NM-${year}-${padded}`;
}

// ─── 3. Class status badge ───────────────────────────────────────────────────

export interface StatusBadge {
  label: string;    // English label
  labelMM: string;  // Myanmar label
  color: string;    // Tailwind utility classes (bg + text)
}

const CLASS_STATUS_BADGES: Record<ClassStatus, StatusBadge> = {
  draft:  { label: "Draft",   labelMM: "မူကြမ်း",       color: "bg-gray-100 text-gray-700"     },
  open:   { label: "Open",    labelMM: "ဖွင့်လှစ်ထား",  color: "bg-green-100 text-green-700"   },
  full:   { label: "Full",    labelMM: "နေရာပြည့်",     color: "bg-orange-100 text-orange-700" },
  closed: { label: "Closed",  labelMM: "ပိတ်သိမ်းပြီ",  color: "bg-red-100 text-red-700"       },
};

/**
 * Returns a bilingual badge descriptor for a class status.
 * Falls back to a neutral gray badge for unknown values.
 */
export function getClassStatusBadge(status: string): StatusBadge {
  return (
    CLASS_STATUS_BADGES[status as ClassStatus] ?? {
      label: status,
      labelMM: status,
      color: "bg-gray-100 text-gray-500",
    }
  );
}

// ─── 4. Myanmar phone formatter ───────────────────────────────────────────────

// Myanmar mobile numbers:
//   Local  : 09[5-9]\d{7,8}  →  09-xxx-xxx-xxx
//   Intl   : +959[5-9]\d{7,8} → +959-xxx-xxx-xxx
// Digits after country prefix are 9–10 digits total (including the leading 9).
const MM_PHONE_RE = /^(?:\+?95|0)(9\d{7,9})$/;

/**
 * Validates and formats a Myanmar mobile number.
 * Accepts: "09791234567", "+959791234567", "09-791234567", etc.
 * Returns: "09-791-234-567"  or  "+959-791-234-567" (for +95 input).
 * Throws if the number does not match a recognised Myanmar mobile format.
 */
export function formatMyanmarPhone(phone: string): string {
  // Strip spaces, dashes, and parentheses before matching
  const cleaned = phone.replace(/[\s\-().]/g, "");

  const match = cleaned.match(MM_PHONE_RE);
  if (!match) {
    throw new Error(
      `Invalid Myanmar phone number: "${phone}". ` +
        "Expected format: 09xxxxxxxxx or +959xxxxxxxxx",
    );
  }

  const digits = match[1]; // e.g. "9791234567"
  const usesIntlPrefix = cleaned.startsWith("+95") || cleaned.startsWith("959");

  // Group as XXX-XXX-XXXX or XXX-XXX-XXX depending on length
  const groups = digits.match(/^(\d{3})(\d{3})(\d{3,4})$/) ?? null;
  const formatted = groups
    ? `${groups[1]}-${groups[2]}-${groups[3]}`
    : digits;

  return usesIntlPrefix ? `+959-${formatted}` : `09-${formatted}`;
}

// ─── 5. Application config ───────────────────────────────────────────────────

export const NIHON_MOMENT_CONFIG = {
  schoolName:   "Nihon Moment",
  schoolNameMM: "နီဟွန်းမိုးမန့်",
  currency:     "MMK",
  defaultFees:  {
    N5: 300_000,
    N4: 350_000,
    N3: 400_000,
    N2: 450_000,
    N1: 500_000,
  } satisfies Record<JlptLevel, number>,
  supportedBanks: ["KBZ", "AYA", "CB", "UAB", "Yoma"] as const,
  languages:      ["en", "my"] as const,
} as const;

export type SupportedBank     = (typeof NIHON_MOMENT_CONFIG.supportedBanks)[number];
export type SupportedLanguage = (typeof NIHON_MOMENT_CONFIG.languages)[number];
