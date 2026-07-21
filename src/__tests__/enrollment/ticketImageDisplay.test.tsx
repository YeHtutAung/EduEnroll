import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  TemplateClass,
  TemplateIntake,
  TemplateLabels,
} from "@/components/enrollment/templates/types";

// ─── Ticket artwork must not be cropped ─────────────────────────────────────
//
// Event posters are landscape (the flashtic artwork is 1200x630, ~1.91:1).
// This card used to render them in a 74x100 PORTRAIT box with
// objectFit:"cover", which keeps a centre strip about a quarter of the width —
// the title, date, venue and price were all cropped away, leaving only the
// middle of the image.
//
// These assert the geometry that makes cropping impossible rather than a
// screenshot: `w-full` + `h-auto` with no object-fit lets the image compute its
// own height, so it stays whole at every viewport width without hard-coding a
// ratio. Verified in a real browser at 375px and 750px: rendered aspect ratio
// 1.905 in both, exactly matching the source.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const IMAGE = "https://example.test/storage/class-images/poster.jpeg";

const cls: TemplateClass = {
  id: "c1",
  level: "Early bird",
  fee_amount: 50,
  fee_formatted: "50 SGD",
  seat_remaining: 81,
  seat_total: 100,
  enrollment_open_at: null,
  enrollment_close_at: null,
  status: "open",
  image_url: IMAGE,
  max_tickets_per_person: 10,
};

const intake: TemplateIntake = { id: "i1", name: "August 2026 Event", year: 2026, status: "open" };

const labels: TemplateLabels = {
  intake: "Event",
  class: "Ticket Type",
  student: "Attendee",
  seat: "Seat",
  fee: "Fee",
  orgType: "event",
  currency: "SGD",
};

async function markup(overrides: Partial<TemplateClass> = {}) {
  const { default: Template } =
    await import("@/components/enrollment/templates/EvTrustedOfficialTemplate");
  return renderToStaticMarkup(
    <Template
      appearance={{ brand_color: "#1e40af" } as never}
      intake={intake}
      classes={[{ ...cls, ...overrides }]}
      labels={labels}
      slug="august-2026"
      currency="SGD"
    />,
  );
}

/** The <img> tag for the ticket artwork. */
async function imgTag(overrides: Partial<TemplateClass> = {}) {
  const html = await markup(overrides);
  const m = html.match(
    new RegExp(`<img[^>]*${IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^>]*>`),
  );
  return m ? m[0] : null;
}

describe("EvTrustedOfficial ticket artwork", () => {
  it("renders the artwork full width at its natural height", async () => {
    const img = await imgTag();

    expect(img).not.toBeNull();
    expect(img).toContain("w-full");
    expect(img).toContain("h-auto");
  });

  it("pins no fixed width or height on the artwork", async () => {
    // The old box was width:74/height:100. A fixed pair forces an aspect ratio,
    // and any source that does not match it gets cropped or squashed.
    const img = await imgTag();

    expect(img).not.toMatch(/width:\s*74/);
    expect(img).not.toMatch(/height:\s*100/);
    expect(img).not.toMatch(/style="[^"]*\bwidth:\s*\d/);
    expect(img).not.toMatch(/style="[^"]*\bheight:\s*\d/);
  });

  it("does not crop via object-fit", async () => {
    // object-fit:cover is what actually discarded the artwork.
    const img = await imgTag();

    expect(img).not.toMatch(/object-fit:\s*cover/);
    expect(img).not.toContain("object-cover");
  });

  it("omits the image element entirely when a ticket has no artwork", async () => {
    const html = await markup({ image_url: null });

    expect(html).not.toContain("<img");
    // The card itself still renders.
    expect(html).toContain("Early bird");
  });
});
