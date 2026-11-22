import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountView, readProfileResponse } from "@/app/(public)/account/AccountSignIn";
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

  it("staff session on load: its own text, no form, and no sign-out for a password session", () => {
    const html = render({ step: "staffSession", canSignOut: false, busy: false });
    expect(html).toContain("signed in as staff on this site");
    expect(html).toContain("use another browser");
    expect(html).not.toContain("Use a different email");
    expect(html).toContain("ဝန်ထမ်း");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
  });

  it("staff session on load: a left-over code session gets a Sign out button", () => {
    const html = render({ step: "staffSession", canSignOut: true, busy: false });
    expect(html).toMatch(/<button[^>]*>Sign out/);
    expect(html).toContain("ထွက်ရန်");
  });

  it("code step: a 6-digit field, Use another email and Resend", () => {
    const html = render({ step: "code", email: "buyer@example.com", busy: false, notice: null });
    expect(html).toMatch(/<input[^>]*inputMode="numeric"|<input[^>]*inputmode="numeric"/i);
    expect(html).toMatch(/<input[^>]*autoComplete="one-time-code"|<input[^>]*autocomplete="one-time-code"/i);
    // Room for a pasted "482 913".
    expect(html).toMatch(/<input[^>]*maxlength="12"/i);
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

  it("the account-ready notice asks to sign in once more, in both languages", () => {
    const html = render({ step: "email", email: "a@b.co", busy: false, notice: "accountReady" });
    expect(html).toContain("Your account is ready. Sign in once more to continue.");
    expect(html).toMatch(/[က-႟]/);
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

  it("both forms post, never a native GET that would put input in the URL", () => {
    for (const state of [
      { step: "email", email: "", busy: false, notice: null },
      { step: "code", email: "a@b.co", busy: false, notice: null },
    ] as AccountState[]) {
      expect(render(state)).toMatch(/<form[^>]*method="post"/);
    }
  });

  it("forms carry aria-busy", () => {
    expect(render({ step: "email", email: "a@b.co", busy: true, notice: null })).toMatch(
      /<form[^>]*aria-busy="true"/,
    );
    expect(render({ step: "code", email: "a@b.co", busy: false, notice: null })).toMatch(
      /<form[^>]*aria-busy="false"/,
    );
  });

  it("shows Sending… while sending a code", () => {
    const html = render({ step: "email", email: "a@b.co", busy: true, notice: null });
    expect(html).toContain("Sending…");
    expect(html).toMatch(MYANMAR);
  });

  it("shows Checking… while verifying, and Sending… on Resend", () => {
    const verifying = render({ step: "code", email: "a@b.co", busy: true, notice: null });
    expect(verifying).toContain("Checking…");
    const resending = render({ step: "code", email: "a@b.co", busy: true, notice: null, resending: true });
    expect(resending).toContain("Sending…");
    expect(resending).not.toContain("Checking…");
  });

  it("does not say Sending… while signing out", () => {
    const html = render({ step: "email", email: "", busy: true, notice: "staff", signingOut: true });
    expect(html).not.toContain("Sending…");
  });

  it("focuses the code field, and the email field only on returning", () => {
    expect(render({ step: "code", email: "a@b.co", busy: false, notice: null })).toMatch(
      /<input[^>]*name="code"[^>]*autofocus|<input[^>]*autofocus[^>]*name="code"/i,
    );
    const first = render({ step: "email", email: "", busy: false, notice: null });
    expect(first).not.toMatch(/autofocus/i);
    const back = render({ step: "email", email: "a@b.co", busy: false, notice: null });
    expect(back).toMatch(/autofocus/i);
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

describe("readProfileResponse", () => {
  it("reads the email from a profile", async () => {
    const res = new Response(JSON.stringify({ email: "a@b.co", name: null, locale: "my" }), { status: 200 });
    expect(await readProfileResponse(res)).toEqual({ email: "a@b.co", reason: undefined });
  });

  it("reads a top-level reason (sign_in_again) beside the email", async () => {
    const res = new Response(
      JSON.stringify({ email: "a@b.co", name: null, locale: "my", reason: "sign_in_again" }),
      { status: 201 },
    );
    expect(await readProfileResponse(res)).toEqual({ email: "a@b.co", reason: "sign_in_again" });
  });

  it("reads error.reason from a 403", async () => {
    const res = new Response(
      JSON.stringify({ error: { code: "FORBIDDEN", message: "x", reason: "staff" } }),
      { status: 403 },
    );
    expect(await readProfileResponse(res)).toEqual({ email: undefined, reason: "staff" });
  });

  it("a missing or non-string email comes back undefined", async () => {
    expect(await readProfileResponse(new Response(JSON.stringify({ name: "x" })))).toEqual({
      email: undefined,
      reason: undefined,
    });
    expect(await readProfileResponse(new Response(JSON.stringify({ email: 42 })))).toEqual({
      email: undefined,
      reason: undefined,
    });
  });

  it("a non-JSON body never throws", async () => {
    expect(await readProfileResponse(new Response("<html>502</html>", { status: 502 }))).toEqual({});
    expect(await readProfileResponse(new Response("", { status: 503 }))).toEqual({});
    expect(await readProfileResponse(new Response("null"))).toEqual({});
  });
});
