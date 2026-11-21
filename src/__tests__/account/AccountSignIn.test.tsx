import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountView } from "@/app/(public)/account/AccountSignIn";
import type { AccountState } from "@/app/(public)/account/accountFlow";

// Effects don't run under react-dom/server, so the presentational view is
// rendered per state. The flow itself is covered in accountFlow.test.ts.

const noop = () => {};
const handlers = {
  onSubmitEmail: noop,
  onSubmitCode: noop,
  onResend: noop,
  onUseAnotherEmail: noop,
  onSignOut: noop,
  onRetryLoad: noop,
  onRetryProfile: noop,
};
const render = (state: AccountState) => renderToStaticMarkup(<AccountView state={state} {...handlers} />);

// Any character in the Myanmar Unicode block.
const MYANMAR = /[က-႟]/;

describe("AccountView", () => {
  it("loading", () => {
    const html = render({ step: "loading" });
    expect(html).toContain("Loading");
    expect(html).toMatch(MYANMAR);
    expect(html).not.toContain("<input");
  });

  it("email step: an email field and Send code, in both languages", () => {
    const html = render({ step: "email", email: "", busy: false, notice: null });
    expect(html).toMatch(/<input[^>]*type="email"/);
    expect(html).toMatch(/<input[^>]*autoComplete="email"|<input[^>]*autocomplete="email"/i);
    expect(html).toContain("Send code");
    expect(html).toContain("ကုဒ် ပို့ရန်");
    expect(html).toContain("Sign in with your email");
    expect(html).toMatch(MYANMAR);
  });

  it("email step pre-fills the last address after 'Use another email'", () => {
    const html = render({ step: "email", email: "buyer@example.com", busy: false, notice: null });
    expect(html).toContain('value="buyer@example.com"');
  });

  it("email step: the too-many-codes notice", () => {
    const html = render({ step: "email", email: "a@b.co", busy: false, notice: "tooManyCodes" });
    expect(html).toContain("Too many codes requested");
    expect(html).toContain('role="alert"');
  });

  it("staff message after a code, in both languages", () => {
    const html = render({ step: "email", email: "", busy: false, notice: "staff" });
    expect(html).toContain(
      "This address belongs to a staff account. Use a different email to buy tickets.",
    );
    expect(html).toContain("ဝန်ထမ်းအကောင့်");
  });

  it("staff session on load: the staff message, no form and no sign-out button", () => {
    const html = render({ step: "staffSession" });
    expect(html).toContain("This address belongs to a staff account.");
    expect(html).toContain("ဝန်ထမ်းအကောင့်");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Sign out");
  });

  it("code step: a 6-digit field, Use another email and Resend", () => {
    const html = render({ step: "code", email: "buyer@example.com", busy: false, notice: null });
    expect(html).toMatch(/<input[^>]*inputMode="numeric"|<input[^>]*inputmode="numeric"/i);
    expect(html).toMatch(/<input[^>]*autoComplete="one-time-code"|<input[^>]*autocomplete="one-time-code"/i);
    expect(html).toMatch(/<input[^>]*maxLength="6"|<input[^>]*maxlength="6"/i);
    expect(html).toContain("buyer@example.com");
    expect(html).toContain("Use another email");
    expect(html).toContain("အခြား အီးမေးလ် သုံးရန်");
    expect(html).toContain("Resend code");
    expect(html).toContain("ကုဒ် ပြန်ပို့ရန်");
  });

  it("code step never pre-fills the code field", () => {
    const html = render({ step: "code", email: "buyer@example.com", busy: false, notice: "wrongCode" });
    const codeInput = html.match(/<input[^>]*name="code"[^>]*>/)?.[0] ?? "";
    expect(codeInput).not.toBe("");
    expect(codeInput).not.toContain("value=");
    expect(html).toContain("wrong or has expired");
  });

  it("signed in: the account email and Sign out", () => {
    const html = render({ step: "signedIn", email: "buyer@example.com", busy: false });
    expect(html).toContain("buyer@example.com");
    expect(html).toContain("Sign out");
    expect(html).toContain("ထွက်ရန်");
    expect(html).not.toContain("<input");
  });

  it("load failure offers Try again", () => {
    const html = render({ step: "loadFailed" });
    expect(html).toContain("Try again");
    expect(html).toMatch(MYANMAR);
  });

  it("profile failure offers Try again and Use another email", () => {
    const html = render({ step: "profileFailed", email: "buyer@example.com", busy: false });
    expect(html).toContain("Try again");
    expect(html).toContain("Use another email");
  });

  it("the deletion-in-progress notice", () => {
    const html = render({ step: "email", email: "", busy: false, notice: "deletion" });
    expect(html).toContain("being deleted");
    expect(html).toMatch(MYANMAR);
  });

  it("disables the buttons while busy", () => {
    const html = render({ step: "code", email: "buyer@example.com", busy: true, notice: null });
    expect(html.match(/<button[^>]*disabled/g)?.length).toBe(3);
  });

  it("marks new Myanmar strings for native review", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/app/(public)/account/AccountSignIn.tsx"),
      "utf8",
    );
    expect(src).toMatch(/native review/i);
  });

  it("never logs or puts the code in a URL", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/app/(public)/account/AccountSignIn.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/[?&]code=|searchParams/);
  });
});
