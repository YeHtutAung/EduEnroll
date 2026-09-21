import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TermsConsent from "@/components/enrollment/TermsConsent";

function render(props: Partial<Parameters<typeof TermsConsent>[0]> = {}) {
  return renderToStaticMarkup(
    <TermsConsent checked={false} onChange={() => {}} organiserTerms={null} {...props} />,
  );
}

describe("TermsConsent", () => {
  // Pop-ups, not new tabs: the buyer reads the document without leaving the
  // form they are filling in.
  it("opens the Terms of Sale and Privacy Policy as pop-ups, not links away", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]+type="button"[^>]*>Terms of Sale<\/button>/);
    expect(html).toMatch(/<button[^>]+type="button"[^>]*>Privacy Policy<\/button>/);
    expect(html).not.toContain('href="/terms"');
    expect(html).not.toContain('href="/privacy"');
  });

  // Buyers agree to the Terms of Sale (and event rules) only. The Privacy
  // Policy is information, linked beneath — not part of what the box accepts.
  it("asks agreement to the Terms of Sale only, with the Privacy Policy outside the checkbox label", () => {
    const html = render();
    const label = html.match(/<label[\s\S]*?<\/label>/)![0];
    expect(label).toContain("Terms of Sale");
    expect(label).not.toContain("Privacy Policy");
    expect(label).not.toContain("ကိုယ်ရေးအချက်အလက်မူဝါဒ");
    expect(html.slice(html.indexOf("</label>"))).toContain("Privacy Policy");
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
