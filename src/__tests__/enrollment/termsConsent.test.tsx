import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TermsConsent from "@/components/enrollment/TermsConsent";

function render(props: Partial<Parameters<typeof TermsConsent>[0]> = {}) {
  return renderToStaticMarkup(
    <TermsConsent checked={false} onChange={() => {}} organiserTerms={null} {...props} />,
  );
}

describe("TermsConsent", () => {
  it("links the Terms of Sale and Privacy Policy in a new tab, so the form is not lost", () => {
    const html = render();
    expect(html).toMatch(/<a[^>]+href="\/terms"[^>]+target="_blank"/);
    expect(html).toMatch(/<a[^>]+href="\/privacy"[^>]+target="_blank"/);
  });

  it("states the agreement in English and Myanmar", () => {
    const html = render();
    expect(html).toContain("I agree to the");
    expect(html).toContain("font-myanmar");
  });

  it("shows no organiser-rules box when the event has none", () => {
    expect(render({ organiserTerms: null })).not.toContain("Event rules");
  });

  it("shows the organiser's rules as plain text, never as markup", () => {
    const html = render({ organiserTerms: "Bags are searched.\n<script>alert(1)</script>" });
    expect(html).toContain("Event rules");
    expect(html).toContain("Bags are searched.");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("reflects the checked state", () => {
    expect(render({ checked: true })).toMatch(/<input[^>]+checked=""/);
    expect(render({ checked: false })).not.toMatch(/<input[^>]+checked=""/);
  });

  it("marks itself invalid when the buyer tried to continue without ticking it", () => {
    expect(render({ showError: true })).toContain('aria-invalid="true"');
  });
});
