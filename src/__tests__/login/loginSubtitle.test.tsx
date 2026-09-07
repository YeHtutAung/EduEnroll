import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import LoginForm from "@/app/login/LoginForm";

// The subtitle under the tenant name was a hardcoded map keyed by org_type,
// with the `event` slot holding one specific festival name. Every event tenant
// therefore saw the same festival on their admin login, regardless of who they
// were. These assert the two properties that fix it: the tenant's own event
// wins, and the fallback is a CATEGORY rather than anyone's event.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const render = (props: Partial<Parameters<typeof LoginForm>[0]>) =>
  renderToStaticMarkup(
    <LoginForm
      schoolName="Louder Myanmar"
      schoolNameMm={null}
      tenantSlug="brave"
      orgType="event"
      {...props}
    />,
  );

describe("admin login subtitle", () => {
  it("shows the tenant's own current event", () => {
    const html = render({ subtitle: "Rock In Mandalay" });
    expect(html).toContain("Rock In Mandalay");
  });

  it("never shows one tenant's event to another", () => {
    // flashtic is also org_type "event" and must not inherit brave's festival.
    const html = render({ schoolName: "flashtic", subtitle: "Burmese Fusion 2026" });
    expect(html).toContain("Burmese Fusion 2026");
    expect(html).not.toContain("Rock In Mandalay");
  });

  it("falls back to a category label, not a festival name", () => {
    const html = render({ subtitle: null });
    expect(html).toContain("Event");
    expect(html).not.toContain("Thingyan Music Festival 2026");
  });

  it("keeps the language-school label unchanged", () => {
    const html = render({ orgType: "language_school", subtitle: null });
    expect(html).toContain("Language School");
  });

  it("hardcodes no event name anywhere in the source", () => {
    // The regression is a specific event name living in the component. Any
    // festival-shaped literal here means it is back.
    const src = readFileSync(
      path.resolve(process.cwd(), "src/app/login/LoginForm.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/Thingyan|Festival \d{4}|Rock In Mandalay/);
  });
});
