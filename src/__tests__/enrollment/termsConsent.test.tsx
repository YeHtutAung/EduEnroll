import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TermsConsent from "@/components/enrollment/TermsConsent";

function render(props: Partial<Parameters<typeof TermsConsent>[0]> = {}) {
  return renderToStaticMarkup(
    <TermsConsent checked={false} onChange={() => {}} organiserTerms={null} {...props} />,
  );
}

describe("TermsConsent", () => {
  // A pop-up, not a new tab: the buyer reads the terms without leaving the
  // form they are filling in.
  it("opens the Terms of Sale as a pop-up, not a link away", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]+type="button"[^>]*>Terms of Sale<\/button>/);
    expect(html).not.toContain('href="/terms"');
  });

  // Buyers agree to the Terms of Sale (and event rules) only, and the form
  // shows nothing about the Privacy Policy (removed at the owner's request;
  // /privacy stays on the site).
  it("asks agreement to the Terms of Sale only and does not mention the Privacy Policy", () => {
    const html = render({ organiserTerms: "Bags are searched." });
    expect(html).toContain("Terms of Sale");
    expect(html).not.toContain("Privacy Policy");
    expect(html).not.toContain("ကိုယ်ရေးအချက်အလက်မူဝါဒ");
    expect(html).not.toContain("How we handle your information");
  });

  it("renders no pop-up until one is opened", () => {
    expect(render()).not.toContain('role="dialog"');
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
