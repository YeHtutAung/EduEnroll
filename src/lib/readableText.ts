// ─── Readable text on an organiser's brand colour ───────────────────────────
//
// Buttons are filled with the tenant's Primary Color (Admin → Appearance),
// which can be anything — The Beats Run uses a bright yellow, where the white
// text these buttons always had was close to unreadable.
//
// White stays unless it falls below 3:1 against the fill (WCAG 2.x contrast).
// Not "whichever is higher": mid-tone brand colours such as the default blue
// #2563eb score slightly better with black (5.0 vs 4.2), yet white on them is
// the conventional, perfectly legible look every existing tenant has. Only a
// genuinely light fill — yellow, gold, pastels — flips to black.

const WHITE = "#ffffff";
const BLACK = "#000000";

/** Below this contrast against white, text switches to black. */
const MIN_WHITE_CONTRAST = 3;

/** Parses `#rgb` / `#rrggbb` (case-insensitive) into 0–255 channels, else null. */
function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Text colour for a button filled with `background`: white, or black when the
 * fill is too light for white to read.
 *
 * Anything that is not a hex colour falls back to white — what these buttons
 * showed before — so a malformed setting changes nothing.
 */
export function readableTextColor(background: string): string {
  const rgb = parseHex(background);
  if (!rgb) return WHITE;
  // Contrast ratio = (lighter + 0.05) / (darker + 0.05); white's luminance is 1.
  const vsWhite = 1.05 / (relativeLuminance(rgb) + 0.05);
  return vsWhite < MIN_WHITE_CONTRAST ? BLACK : WHITE;
}
