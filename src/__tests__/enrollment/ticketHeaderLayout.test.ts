import { describe, it, expect } from "vitest";
import { headerRightReserve, boxFor, overlaps, TICKET_ROWS } from "@/lib/tickets/ticketLayout";

// ─── Ticket card text must never land on other text ─────────────────────────
//
// Three separate collisions have been found here, and all three are encoded
// below so none can return:
//
// 1. The header reserved a guessed 132px for a block measuring 190.7px, so the
//    fitted event name ran 46px into it.
// 2. Moving the ticket index to "its own line" fixed that and created a
//    vertical one: baseline 156 sits between the event name (120) and the tier
//    (204), but at 87px the tier's GLYPH BOX starts at y=141 while the index's
//    ended at y=156. Baseline ordering is not separation.
// 3. Asserting boxes then exposed a pre-existing one: the "ORDER REF" caption
//    ended 6px below the top of the reference beneath it.
//
// The per-string metrics below are MEASURED from the real canvas
// (actualBoundingBoxAscent/Descent on Helvetica), not modelled. An earlier
// attempt at this test used blanket ratios and produced a false positive on
// exactly the pair that turned out to be fine — a guessed model is how the
// original bug got in, so it is not how the guard should work.

interface Metric {
  key: keyof typeof TICKET_ROWS;
  /** Font size in layout units after the renderer's fit-to-width pass. */
  size: number;
  ascentRatio: number;
  descentRatio: number;
  /** Rendered width in layout units. */
  width: number;
}

/** Measured for the reported ticket: "AUGUST 2026 EVENT" / "Early bird" / "F-0722-CEQ7". */
const MEASURED: Metric[] = [
  { key: "eventName", size: 6.5, ascentRatio: 0.7179, descentRatio: 0, width: 67.2 },
  { key: "tier", size: 14.5, ascentRatio: 0.7241, descentRatio: 0.2069, width: 66.9 },
  { key: "orderRefLabel", size: 7, ascentRatio: 0.7143, descentRatio: 0, width: 32.1 },
  { key: "orderRef", size: 10.75, ascentRatio: 0.7442, descentRatio: 0.0775, width: 66.9 },
  { key: "ticketId", size: 6, ascentRatio: 0.7222, descentRatio: 0, width: 67.4 },
];

const CARD_LEFT = 16; // layout units
const CARD_WIDTH = 68;

function boxes(scale: number) {
  return MEASURED.map((m) => ({
    key: m.key,
    box: boxFor({
      x: CARD_LEFT * scale,
      baseline: TICKET_ROWS[m.key] * scale,
      width: m.width * scale,
      fontSize: m.size * scale,
      ascentRatio: m.ascentRatio,
      descentRatio: m.descentRatio,
    }),
  }));
}

function collisions(scale: number): string[] {
  const b = boxes(scale);
  const found: string[] = [];
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      if (overlaps(b[i].box, b[j].box)) found.push(`${b[i].key} ∩ ${b[j].key}`);
    }
  }
  return found;
}

describe("ticket card text boxes", () => {
  // Canvas draws at S=6; the PDF treats the same rows as millimetres. A layout
  // safe in only one coordinate system is not safe.
  for (const [name, scale] of [
    ["canvas (S=6)", 6],
    ["pdf (mm)", 1],
  ] as const) {
    it(`${name}: no two elements overlap`, () => {
      expect(collisions(scale)).toEqual([]);
    });

    it(`${name}: every element stays inside the card`, () => {
      for (const { key, box } of boxes(scale)) {
        expect(box.x0, `${key} starts before the card`).toBeGreaterThanOrEqual(CARD_LEFT * scale);
        expect(box.x1, `${key} runs past the card`).toBeLessThanOrEqual(
          (CARD_LEFT + CARD_WIDTH) * scale + 0.01,
        );
      }
    });
  }

  it("keeps the ORDER REF caption clear of the reference", () => {
    // Collision 3, the pre-existing one: at row 40 the caption's box ended 6px
    // below the reference's top.
    const scale = 6;
    const caption = boxFor({
      x: CARD_LEFT * scale,
      baseline: 40 * scale,
      width: 32.1 * scale,
      fontSize: 7 * scale,
      ascentRatio: 0.7143,
      descentRatio: 0,
    });
    const ref = boxes(scale).find((b) => b.key === "orderRef")!.box;

    expect(caption.bottom).toBeGreaterThan(ref.top); // the old row 40
    expect(overlaps(caption, ref)).toBe(true);
    // The shipped row does not.
    expect(TICKET_ROWS.orderRefLabel).toBeLessThan(40);
  });

  it("catches an index given its own line between the header and the tier", () => {
    // Collision 2, reconstructed. This is why the index now rides the ticket-id
    // line instead of getting a row of its own.
    const scale = 6;
    const tier = boxes(scale).find((b) => b.key === "tier")!.box;
    const strayIndex = boxFor({
      x: (CARD_LEFT + CARD_WIDTH) * scale,
      baseline: 18 * scale,
      width: 30.5 * scale,
      fontSize: 6 * scale,
      align: "right",
      ascentRatio: 0.7222,
      descentRatio: 0,
    });

    expect(overlaps(strayIndex, tier)).toBe(true);
    // No row is defined between the header and the tier, so this cannot recur.
    expect(Object.values(TICKET_ROWS).some((r) => r > 12 && r < 26)).toBe(false);
  });
});

describe("headerRightReserve", () => {
  const measure = (t: string) => t.length * 20;

  it("reserves the fixed box for a presenting sponsor with a logo", () => {
    expect(headerRightReserve({ measure, gap: 24, sponsorReserve: 252, sponsorName: null })).toBe(
      252,
    );
  });

  it("measures a presenting sponsor drawn as a wordmark", () => {
    const reserve = headerRightReserve({
      measure,
      gap: 24,
      sponsorReserve: 252,
      sponsorName: "Softbank International",
      sponsorMarkAllowance: 84,
    });

    expect(reserve).toBe(measure("Softbank International") + 84 + 24);
    expect(reserve).toBeGreaterThan(252);
  });

  it("reserves nothing when there is no sponsor — the common path", () => {
    expect(headerRightReserve({ measure, gap: 24, sponsorReserve: 0 })).toBe(0);
  });
});
