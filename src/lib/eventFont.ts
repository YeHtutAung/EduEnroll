// ─── Custom web font per event ──────────────────────────────────────────────
//
// An event can name one Adobe Fonts web project (stylesheet + font-family) for
// its public landing page. Adobe Fonts is the supported source because it
// carries the web licence; most desktop font files do not allow serving the
// font to website visitors.
//
// The rules here mirror the CHECK constraints in
// 20261023120000_intake_custom_font.sql, so a bad value is a 400 naming the
// problem rather than an opaque write failure:
//   - the stylesheet must be https://use.typekit.net/<id>.css — it is loaded
//     into a public page, so the host cannot be the organiser's choice;
//   - the family name goes into an inline style, so only letters, digits,
//     spaces and hyphens;
//   - both or neither.

export const ADOBE_FONTS_CSS_RE = /^https:\/\/use\.typekit\.net\/[a-z0-9]{1,32}\.css$/;
export const FONT_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/;

export interface EventFont {
  font_css_url: string | null;
  font_family: string | null;
}

export type EventFontResult = { ok: true; value: EventFont } | { ok: false; message: string };

/**
 * Validates an event font pair from the admin form. Blank or null in BOTH
 * clears the font; one without the other is an error.
 */
export function validateEventFont(cssUrl: unknown, family: unknown): EventFontResult {
  for (const [name, v] of [["font_css_url", cssUrl], ["font_family", family]] as const) {
    if (v !== null && v !== undefined && typeof v !== "string") {
      return { ok: false, message: `${name} must be a string or null.` };
    }
  }
  const url = typeof cssUrl === "string" ? cssUrl.trim() : "";
  const fam = typeof family === "string" ? family.trim() : "";

  if (!url && !fam) return { ok: true, value: { font_css_url: null, font_family: null } };
  if (!url || !fam) {
    return { ok: false, message: "Set both the Adobe Fonts link and the font name, or neither." };
  }
  if (!ADOBE_FONTS_CSS_RE.test(url)) {
    return {
      ok: false,
      message: "The font link must be an Adobe Fonts web project link like https://use.typekit.net/abc1234.css.",
    };
  }
  if (!FONT_FAMILY_RE.test(fam)) {
    return {
      ok: false,
      message: "The font name may only contain letters, numbers, spaces and hyphens (max 64).",
    };
  }
  return { ok: true, value: { font_css_url: url, font_family: fam } };
}

/**
 * A CSS font-family value: the event's font first, then `fallback`.
 *
 * Falling back matters beyond a slow load — a Latin display face has no
 * Myanmar glyphs, so Myanmar text must reach a font that does. Returns
 * `fallback` alone when the event has no (valid) font.
 */
export function eventFontStack(family: string | null | undefined, fallback: string): string {
  return family && FONT_FAMILY_RE.test(family) ? `'${family}', ${fallback}` : fallback;
}

/** The stylesheet to load, or null when the event has no (valid) font. */
export function eventFontCssUrl(url: string | null | undefined): string | null {
  return url && ADOBE_FONTS_CSS_RE.test(url) ? url : null;
}

/** The app's default text stack (tailwind `font-sans`), Myanmar included. */
const APP_SANS = "var(--font-noto-sans), var(--font-noto-sans-myanmar), sans-serif";

/**
 * Root style for an event template that inherits its fonts: the event's font
 * over the app's default stack, or nothing when the event has none — so a
 * template without a custom font renders exactly as before.
 */
export function eventFontStyle(intake: Partial<EventFont>): { fontFamily?: string } {
  if (!eventFontCssUrl(intake.font_css_url) || !intake.font_family) return {};
  return { fontFamily: eventFontStack(intake.font_family, APP_SANS) };
}
