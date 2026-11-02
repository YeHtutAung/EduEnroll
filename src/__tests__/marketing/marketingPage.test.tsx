import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImgHTMLAttributes } from "react";

vi.mock("next/image", () => ({
  default: ({ src, alt, priority, fill, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean; fill?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} data-fill={fill ? "1" : undefined} data-priority={priority ? "1" : undefined} {...rest} />
  ),
}));

import MarketingPage from "@/components/marketing/MarketingPage";
import { defaultContent } from "@/lib/marketing/defaultContent";
import type { MarketingContent } from "@/lib/marketing/content";

const clone = (): MarketingContent => JSON.parse(JSON.stringify(defaultContent));
const html = (c: MarketingContent) => renderToStaticMarkup(<MarketingPage content={c} />);

describe("MarketingPage", () => {
  it("renders text as text, not HTML", () => {
    const c = clone();
    c.hero.subtext = "<script>alert(1)</script>";
    expect(html(c)).not.toContain("<script>alert(1)");
  });

  it("hides organizers, payments and industries when switched off", () => {
    const c = clone();
    c.sections.organizers = false;
    c.sections.payments = false;
    c.sections.industries = false;
    const out = html(c);
    expect(out).not.toContain(c.organizers.heading.en);
    expect(out).not.toContain(c.payments.heading.en);
    expect(out).not.toContain(c.industries.heading.en);
  });

  it("hides the card grid and the POS card independently", () => {
    const a = clone();
    a.sections.solutions = false;
    const noCards = html(a);
    expect(noCards).not.toContain(a.solutions.heading.en);
    expect(noCards).toContain(a.pos.title.en.replace("&", "&amp;"));

    const b = clone();
    b.sections.pos = false;
    const noPos = html(b);
    expect(noPos).toContain(b.solutions.heading.en);
    expect(noPos).not.toContain(b.pos.description);
  });

  it("removes every link to #how when How it works is hidden", () => {
    const c = clone();
    c.sections.howItWorks = false;
    const out = html(c);
    expect(out).not.toContain('href="#how"');
    expect(out).not.toContain('id="how"');
    expect(out).not.toContain(c.footer.productHeading);
  });

  it("doesn't render hidden items", () => {
    const c = clone();
    c.organizers.items[0].hidden = true;
    c.payments.items[0].hidden = true;
    c.industries.items[0].hidden = true;
    const out = html(c);
    expect(out).not.toContain(c.organizers.items[0].name);
    expect(out).not.toContain('alt="KBZPay"');
    expect(out).not.toContain(c.industries.items[0].name.en);
  });

  it("numbers steps by visible position", () => {
    const c = clone();
    c.howItWorks.steps[1].hidden = true;
    const out = html(c);
    expect(out).toContain(">03<");
    expect(out).not.toContain(">04<");
  });

  it("drops a section whose items are all hidden", () => {
    const c = clone();
    c.organizers.items.forEach((o) => (o.hidden = true));
    expect(html(c)).not.toContain(c.organizers.heading.en);
  });

  it("renders a bucket image from the current environment's host", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    const c = clone();
    c.hero.image = { kind: "bucket", path: "3f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c.png", width: 10, height: 10 };
    expect(html(c)).toContain(
      "https://abc.supabase.co/storage/v1/object/public/marketing-assets/3f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c.png",
    );
  });
});
