import { describe, it, expect } from "vitest";
import {
  accountReducer,
  bootOnce,
  googleRedirectTo,
  hrefWithoutNotice,
  initialAccount,
  MAX_PROFILE_RETRIES,
  normalizeCode,
  nextFromSearch,
  noticeFromSearch,
  type AccountEvent,
  type Notice,
  type AccountState,
  type Transition,
} from "@/app/(public)/account/accountFlow";

// Every decision on /account lives in this reducer; AccountSignIn only runs the
// effects. These walk the transitions the plan lists (Task 9, states 1–4).

const CODE = "482913";

function run(start: AccountState, ...events: AccountEvent[]): Transition[] {
  const out: Transition[] = [];
  let state = start;
  for (const e of events) {
    const t = accountReducer(state, e);
    out.push(t);
    state = t.state;
  }
  return out;
}
const last = (ts: Transition[]) => ts[ts.length - 1];

const emailState: AccountState = { step: "email", email: "", busy: false, notice: null };
const codeState: AccountState = { step: "code", email: "buyer@example.com", busy: false, notice: null };
/** Code submitted and accepted by Supabase; the first POST is in flight. */
function posting(): AccountState {
  const [, verified] = run(codeState, { type: "submitCode", code: CODE }, { type: "codeVerified" });
  return verified.state;
}

describe("accountFlow — 1. loading", () => {
  it("starts by loading the profile", () => {
    expect(initialAccount()).toEqual({ state: { step: "loading" }, effects: [{ type: "loadProfile" }] });
  });

  it("200 → signed in with the account email", () => {
    const t = accountReducer({ step: "loading" }, { type: "profileLoaded", status: 200, email: "a@b.co" });
    expect(t.state).toEqual({ step: "signedIn", email: "a@b.co", busy: false });
    expect(t.effects).toEqual([]);
  });

  it("401 → email step", () => {
    const t = accountReducer({ step: "loading" }, { type: "profileLoaded", status: 401 });
    expect(t.state).toEqual(emailState);
  });

  it("403 → staff screen WITHOUT signing out; it asks what kind of session it is", () => {
    const t = accountReducer({ step: "loading" }, { type: "profileLoaded", status: 403 });
    expect(t.state).toEqual({ step: "staffSession", canSignOut: false, busy: false });
    expect(t.effects).toEqual([{ type: "checkSession" }]);
  });

  it("staff screen: a password session gets no sign-out", () => {
    const staff = accountReducer({ step: "loading" }, { type: "profileLoaded", status: 403 }).state;
    const t = accountReducer(staff, { type: "sessionChecked", kind: "password" });
    expect(t.state).toEqual({ step: "staffSession", canSignOut: false, busy: false });
    // Even a forged click does nothing.
    const click = accountReducer(t.state, { type: "signOut" });
    expect(click.effects).toEqual([]);
    expect(click.state).toEqual(t.state);
  });

  it("staff screen: no readable session gets no sign-out", () => {
    const staff = accountReducer({ step: "loading" }, { type: "profileLoaded", status: 403 }).state;
    expect(accountReducer(staff, { type: "sessionChecked", kind: "none" }).state).toMatchObject({
      canSignOut: false,
    });
  });

  it("staff screen: a left-over code session can be signed out locally", () => {
    const staff = accountReducer({ step: "loading" }, { type: "profileLoaded", status: 403 }).state;
    const [checked, out, done] = run(
      staff,
      { type: "sessionChecked", kind: "other" },
      { type: "signOut" },
      { type: "signedOut" },
    );
    expect(checked.state).toEqual({ step: "staffSession", canSignOut: true, busy: false });
    expect(out.effects).toEqual([{ type: "signOutLocal" }]);
    expect(done.state).toEqual(emailState);
  });

  it.each([503, 500, 0])("%i → try again, which reloads", (status) => {
    const t = accountReducer({ step: "loading" }, { type: "profileLoaded", status });
    expect(t.state).toEqual({ step: "loadFailed" });
    const retry = accountReducer(t.state, { type: "retryLoad" });
    expect(retry).toEqual(initialAccount());
  });

  it("a 200 without an email is not trusted as signed in", () => {
    const t = accountReducer({ step: "loading" }, { type: "profileLoaded", status: 200 });
    expect(t.state).toEqual({ step: "loadFailed" });
  });
});

describe("accountFlow — 2. email", () => {
  it("trims and lower-cases the email in the sendCode effect", () => {
    const t = accountReducer(emailState, { type: "submitEmail", email: "  Buyer@Example.COM " });
    expect(t.effects).toEqual([{ type: "sendCode", email: "buyer@example.com" }]);
    expect(t.state).toEqual({ step: "email", email: "buyer@example.com", busy: true, notice: null });
  });

  it("refuses an obviously invalid address without sending", () => {
    const t = accountReducer(emailState, { type: "submitEmail", email: "   " });
    expect(t.effects).toEqual([]);
    expect(t.state).toMatchObject({ step: "email", notice: "invalidEmail", busy: false });
  });

  it("ignores a second submit while sending", () => {
    const [first, second] = run(
      emailState,
      { type: "submitEmail", email: "a@b.co" },
      { type: "submitEmail", email: "a@b.co" },
    );
    expect(first.effects).toHaveLength(1);
    expect(second.effects).toEqual([]);
  });

  it("success → code step for that email", () => {
    const t = last(run(emailState, { type: "submitEmail", email: "A@b.co" }, { type: "codeSent" }));
    expect(t.state).toEqual({ step: "code", email: "a@b.co", busy: false, notice: null });
  });

  it("a 429 from sendCode shows 'too many codes'", () => {
    const t = last(run(emailState, { type: "submitEmail", email: "a@b.co" }, { type: "sendFailed", status: 429 }));
    expect(t.state).toEqual({ step: "email", email: "a@b.co", busy: false, notice: "tooManyCodes" });
  });

  it("any other send error shows a generic send failure", () => {
    const t = last(run(emailState, { type: "submitEmail", email: "a@b.co" }, { type: "sendFailed", status: 500 }));
    expect(t.state).toMatchObject({ step: "email", notice: "sendFailed" });
  });
});

describe("accountFlow — 3. code", () => {
  it("submitting a 6-digit code emits exactly one verifyCode effect", () => {
    const t = accountReducer(codeState, { type: "submitCode", code: ` ${CODE} ` });
    expect(t.effects).toEqual([{ type: "verifyCode", email: "buyer@example.com", token: CODE }]);
    expect(t.state).toEqual({ ...codeState, busy: true });
  });

  it("maps Myanmar digits to 0–9 before checking", () => {
    const t = accountReducer(codeState, { type: "submitCode", code: "\u1044\u1048\u1042\u1049\u1041\u1043" });
    expect(t.effects).toEqual([{ type: "verifyCode", email: "buyer@example.com", token: "482913" }]);
  });

  it.each(["482 913", "482-913", " 48 29 13 ", "\u1044\u1048\u1042 \u1049\u1041\u1043"])(
    "strips spaces and dashes from %j",
    (code) => {
      const t = accountReducer(codeState, { type: "submitCode", code });
      expect(t.effects).toEqual([{ type: "verifyCode", email: "buyer@example.com", token: "482913" }]);
    },
  );

  it("normalizeCode leaves other characters for the 6-digit check to refuse", () => {
    expect(normalizeCode("12a456")).toBe("12a456");
  });

  it("refuses a code that isn't 6 digits", () => {
    for (const code of ["12345", "1234567", "abcdef", ""]) {
      const t = accountReducer(codeState, { type: "submitCode", code });
      expect(t.effects, code).toEqual([]);
      expect(t.state, code).toMatchObject({ step: "code", notice: "invalidCode" });
    }
  });

  it("a wrong code stays in the code step with an error", () => {
    const t = last(run(codeState, { type: "submitCode", code: CODE }, { type: "verifyFailed", status: 403 }));
    expect(t.state).toEqual({ ...codeState, notice: "wrongCode" });
    expect(t.effects).toEqual([]);
  });

  it("a rate-limited verify says too many tries", () => {
    const t = last(run(codeState, { type: "submitCode", code: CODE }, { type: "verifyFailed", status: 429 }));
    expect(t.state).toMatchObject({ step: "code", notice: "tooManyTries" });
  });

  it("verified → POST the profile (attempt 0, no delay)", () => {
    const t = last(run(codeState, { type: "submitCode", code: CODE }, { type: "codeVerified" }));
    expect(t.effects).toEqual([{ type: "postProfile", attempt: 0, delayMs: 0 }]);
  });

  it.each([200, 201])("POST %i → signed in", (status) => {
    const t = accountReducer(posting(), { type: "profilePosted", status, attempt: 0, email: "buyer@example.com" });
    expect(t.state).toEqual({ step: "signedIn", email: "buyer@example.com", busy: false });
    expect(t.effects).toEqual([]);
  });

  it.each([200, 201])("POST %i with reason sign_in_again → email kept, 'accountReady', signOutLocal", (status) => {
    const t = accountReducer(posting(), {
      type: "profilePosted",
      status,
      attempt: 0,
      email: "buyer@example.com",
      reason: "sign_in_again",
    });
    expect(t.effects).toEqual([{ type: "signOutLocal" }]);
    expect(t.state).toEqual({
      step: "email",
      email: "buyer@example.com",
      busy: true,
      notice: "accountReady",
      signingOut: true,
    });
    expect(accountReducer(t.state, { type: "signedOut" }).state).toEqual({
      step: "email",
      email: "buyer@example.com",
      busy: false,
      notice: "accountReady",
    });
  });

  it("POST 403 staff → signOutLocal and the staff message, busy until signed out", () => {
    const t = accountReducer(posting(), { type: "profilePosted", status: 403, attempt: 0, reason: "staff" });
    expect(t.effects).toEqual([{ type: "signOutLocal" }]);
    expect(t.state).toEqual({ step: "email", email: "", busy: true, notice: "staff", signingOut: true });
    const done = accountReducer(t.state, { type: "signedOut" });
    expect(done.state).toEqual({ step: "email", email: "", busy: false, notice: "staff" });
  });

  it("a new email can't be submitted until the local sign-out finishes", () => {
    const t = accountReducer(posting(), { type: "profilePosted", status: 403, attempt: 0, reason: "staff" });
    const early = accountReducer(t.state, { type: "submitEmail", email: "other@example.com" });
    expect(early.effects).toEqual([]);
    expect(early.state).toEqual(t.state);
  });

  it("POST 401 → keeps the email, 'expired', signOutLocal", () => {
    const t = accountReducer(posting(), { type: "profilePosted", status: 401, attempt: 0 });
    expect(t.effects).toEqual([{ type: "signOutLocal" }]);
    expect(t.state).toEqual({
      step: "email",
      email: "buyer@example.com",
      busy: true,
      notice: "expired",
      signingOut: true,
    });
    expect(accountReducer(t.state, { type: "signedOut" }).state).toEqual({
      step: "email",
      email: "buyer@example.com",
      busy: false,
      notice: "expired",
    });
  });

  it.each([413, 422, 500])("POST %i → generic error and signOutLocal", (status) => {
    const t = accountReducer(posting(), { type: "profilePosted", status, attempt: 0 });
    expect(t.effects).toEqual([{ type: "signOutLocal" }]);
    expect(t.state).toMatchObject({ step: "email", email: "buyer@example.com", notice: "generic" });
  });

  it("POST 200 without an email is not trusted: generic error and signOutLocal", () => {
    const t = accountReducer(posting(), { type: "profilePosted", status: 200, attempt: 0 });
    expect(t.effects).toEqual([{ type: "signOutLocal" }]);
    expect(t.state).toMatchObject({ step: "email", email: "buyer@example.com", notice: "generic" });
  });

  it.each(["unconfirmed", "not_email_code", undefined])(
    "POST 403 with reason %s → signOutLocal and a generic error",
    (reason) => {
      const t = accountReducer(posting(), { type: "profilePosted", status: 403, attempt: 0, reason });
      expect(t.effects).toEqual([{ type: "signOutLocal" }]);
      expect(t.state).toMatchObject({ step: "email", notice: "generic" });
    },
  );

  it("POST 409 → deletion-in-progress message", () => {
    const t = accountReducer(posting(), { type: "profilePosted", status: 409, attempt: 0 });
    expect(t.state).toMatchObject({ step: "email", notice: "deletion" });
    expect(t.effects).toEqual([{ type: "signOutLocal" }]);
  });

  it("POST 503 retries twice with back-off, then 'try again'", () => {
    const [r1, r2, done] = run(
      posting(),
      { type: "profilePosted", status: 503, attempt: 0 },
      { type: "profilePosted", status: 503, attempt: 1 },
      { type: "profilePosted", status: 503, attempt: 2 },
    );
    expect(MAX_PROFILE_RETRIES).toBe(2);
    expect(r1.effects).toEqual([{ type: "postProfile", attempt: 1, delayMs: 1000 }]);
    expect(r2.effects).toEqual([{ type: "postProfile", attempt: 2, delayMs: 2000 }]);
    expect(done.effects).toEqual([]);
    expect(done.state).toEqual({ step: "profileFailed", email: "buyer@example.com", busy: false });
  });

  it("a retry that succeeds signs in", () => {
    const t = last(
      run(
        posting(),
        { type: "profilePosted", status: 503, attempt: 0 },
        { type: "profilePosted", status: 201, attempt: 1, email: "buyer@example.com" },
      ),
    );
    expect(t.state).toMatchObject({ step: "signedIn" });
  });

  it("'try again' after the retries re-posts the profile", () => {
    const failed: AccountState = { step: "profileFailed", email: "buyer@example.com", busy: false };
    const t = accountReducer(failed, { type: "retryProfile" });
    expect(t.effects).toEqual([{ type: "postProfile", attempt: 0, delayMs: 0 }]);
    const ok = accountReducer(t.state, { type: "profilePosted", status: 200, attempt: 0, email: "buyer@example.com" });
    expect(ok.state).toMatchObject({ step: "signedIn" });
  });

  it("'use another email' after the retries drops the code session", () => {
    const failed: AccountState = { step: "profileFailed", email: "buyer@example.com", busy: false };
    const t = accountReducer(failed, { type: "useAnotherEmail" });
    expect(t.effects).toEqual([{ type: "signOutLocal" }]);
    expect(t.state).toMatchObject({ step: "email", busy: true, signingOut: true });
    expect(accountReducer(t.state, { type: "signedOut" }).state).toEqual({
      step: "email",
      email: "buyer@example.com",
      busy: false,
      notice: null,
    });
  });

  it("'use another email' from the code step goes back without a sign-out", () => {
    const t = accountReducer(codeState, { type: "useAnotherEmail" });
    expect(t.state).toEqual({ step: "email", email: "buyer@example.com", busy: false, notice: null });
    expect(t.effects).toEqual([]);
  });

  it("resend sends a new code to the same email", () => {
    const [sent, done] = run(codeState, { type: "resend" }, { type: "codeSent" });
    expect(sent.effects).toEqual([{ type: "sendCode", email: "buyer@example.com" }]);
    expect(sent.state).toEqual({ ...codeState, busy: true, resending: true });
    expect(done.state).toEqual({ ...codeState, notice: "codeResent" });
  });

  it("a 429 on resend shows 'too many codes' and stays on the code step", () => {
    const t = last(run(codeState, { type: "resend" }, { type: "sendFailed", status: 429 }));
    expect(t.state).toEqual({ ...codeState, notice: "tooManyCodes" });
  });
});

describe("accountFlow — 4. signed in", () => {
  const signedIn: AccountState = { step: "signedIn", email: "buyer@example.com", busy: false };

  it("Sign out → signOutLocal, then back to the email step", () => {
    const [out, done] = run(signedIn, { type: "signOut" }, { type: "signedOut" });
    expect(out.effects).toEqual([{ type: "signOutLocal" }]);
    expect(done.state).toEqual(emailState);
  });

  it("a late signedOut doesn't wipe the staff notice", () => {
    const staff: AccountState = { step: "email", email: "", busy: false, notice: "staff" };
    expect(accountReducer(staff, { type: "signedOut" }).state).toEqual(staff);
  });
});

describe("accountFlow — 403 on load vs 403 after a code", () => {
  it("only the code-step staff 403 signs out", () => {
    const onLoad = accountReducer({ step: "loading" }, { type: "profileLoaded", status: 403 });
    const afterCode = accountReducer(posting(), {
      type: "profilePosted",
      status: 403,
      attempt: 0,
      reason: "staff",
    });
    expect(onLoad.effects.filter((e) => e.type === "signOutLocal")).toHaveLength(0);
    expect(afterCode.effects.filter((e) => e.type === "signOutLocal")).toHaveLength(1);
  });
});

describe("accountFlow — the code never leaks", () => {
  it("only the single verifyCode effect carries the code", () => {
    const transitions = [
      ...run(
        codeState,
        { type: "submitCode", code: CODE },
        { type: "verifyFailed", status: 403 },
        { type: "submitCode", code: CODE },
        { type: "codeVerified" },
        { type: "profilePosted", status: 503, attempt: 0 },
        { type: "profilePosted", status: 503, attempt: 1 },
        { type: "profilePosted", status: 503, attempt: 2 },
        { type: "retryProfile" },
        { type: "profilePosted", status: 403, attempt: 0, reason: "staff" },
      ),
      ...run(codeState, { type: "submitCode", code: "12345" }),
    ];

    const carriers: unknown[] = [];
    for (const t of transitions) {
      expect(JSON.stringify(t.state)).not.toContain(CODE);
      expect(JSON.stringify(t.state)).not.toContain("12345");
      for (const e of t.effects) {
        if (JSON.stringify(e).includes(CODE)) carriers.push(e);
      }
    }
    // Submitted twice (wrong, then right): one verifyCode per submit, nothing else.
    expect(carriers).toEqual([
      { type: "verifyCode", email: "buyer@example.com", token: CODE },
      { type: "verifyCode", email: "buyer@example.com", token: CODE },
    ]);
  });
});

describe("accountFlow — stale events change nothing", () => {
  const sendingEmail: AccountState = { step: "email", email: "a@b.co", busy: true, notice: null };
  const verifying: AccountState = { ...codeState, busy: true };
  const signingOut: AccountState = { step: "email", email: "", busy: true, notice: "staff", signingOut: true };
  const signedIn: AccountState = { step: "signedIn", email: "a@b.co", busy: false };
  const failed: AccountState = { step: "profileFailed", email: "a@b.co", busy: true };

  it.each<[string, AccountState, AccountEvent]>([
    ["profileLoaded on the email step", emailState, { type: "profileLoaded", status: 200, email: "x@y.co" }],
    ["profileLoaded when signed in", signedIn, { type: "profileLoaded", status: 401 }],
    ["profileLoaded on the code step", codeState, { type: "profileLoaded", status: 403 }],
    ["codeSent on an idle email step", emailState, { type: "codeSent" }],
    ["codeSent on an idle code step", codeState, { type: "codeSent" }],
    ["codeSent while verifying", verifying, { type: "codeSent" }],
    ["codeSent while signing out", signingOut, { type: "codeSent" }],
    ["sendFailed on an idle email step", emailState, { type: "sendFailed", status: 429 }],
    ["sendFailed on an idle code step", codeState, { type: "sendFailed", status: 429 }],
    ["sendFailed while signing out", signingOut, { type: "sendFailed" }],
    ["profilePosted on an idle code step", codeState, { type: "profilePosted", status: 200, attempt: 0, email: "x@y.co" }],
    ["profilePosted on the email step", emailState, { type: "profilePosted", status: 403, attempt: 0, reason: "staff" }],
    ["profilePosted when signed in", signedIn, { type: "profilePosted", status: 503, attempt: 0 }],
    ["useAnotherEmail while sending", sendingEmail, { type: "useAnotherEmail" }],
    ["useAnotherEmail while verifying", verifying, { type: "useAnotherEmail" }],
    ["useAnotherEmail while re-posting the profile", failed, { type: "useAnotherEmail" }],
    ["sessionChecked outside the staff screen", emailState, { type: "sessionChecked", kind: "other" }],
    ["signedOut on an idle email step", emailState, { type: "signedOut" }],
  ])("%s", (_name, state, event) => {
    const t = accountReducer(state, event);
    expect(t.state).toBe(state);
    expect(t.effects).toEqual([]);
  });
});

// ─── Continue with Google (buyer accounts plan, Task 15) ────────────────────
describe("accountFlow — Continue with Google", () => {
  it("googleClicked on the email step → busy, startGoogle back to /account", () => {
    const t = accountReducer(emailState, { type: "googleClicked" });
    expect(t.state).toEqual({ step: "email", email: "", busy: true, notice: null, google: true });
    expect(t.effects).toEqual([{ type: "startGoogle", next: "/account" }]);
  });

  it("googleClicked clears an old notice and keeps a typed address", () => {
    const t = accountReducer({ step: "email", email: "a@b.co", busy: false, notice: "staff" }, { type: "googleClicked" });
    expect(t.state).toMatchObject({ email: "a@b.co", notice: null, busy: true });
  });

  it.each<[string, AccountState]>([
    ["while sending a code", { step: "email", email: "a@b.co", busy: true, notice: null }],
    ["while signing out", { step: "email", email: "", busy: true, notice: null, signingOut: true }],
    ["while already opening Google", { step: "email", email: "", busy: true, notice: null, google: true }],
    ["on the code step", codeState],
    ["when signed in", { step: "signedIn", email: "a@b.co", busy: false }],
    ["while loading", { step: "loading" }],
  ])("googleClicked is ignored %s", (_n, state) => {
    const t = accountReducer(state, { type: "googleClicked" });
    expect(t.state).toBe(state);
    expect(t.effects).toEqual([]);
  });

  it("a failed start → back to idle with the google_failed notice", () => {
    const [, t] = run(emailState, { type: "googleClicked" }, { type: "googleFailed" });
    expect(t.state).toEqual({ step: "email", email: "", busy: false, notice: "googleFailed" });
    expect(t.effects).toEqual([]);
  });

  it("coming back from Google (back button) → idle again, no notice", () => {
    const [, t] = run(emailState, { type: "googleClicked" }, { type: "googleReturned" });
    expect(t.state).toEqual({ step: "email", email: "", busy: false, notice: null });
  });

  it("a code result can't land while Google is opening", () => {
    const opening: AccountState = { step: "email", email: "a@b.co", busy: true, notice: null, google: true };
    for (const e of [{ type: "codeSent" }, { type: "sendFailed", status: 429 }] as AccountEvent[]) {
      expect(accountReducer(opening, e).state).toBe(opening);
    }
  });

  it.each<[string, AccountState]>([
    ["idle email step", emailState],
    ["sending a code", { step: "email", email: "a@b.co", busy: true, notice: null }],
    ["code step", codeState],
  ])("googleFailed / googleReturned are ignored on the %s", (_n, state) => {
    expect(accountReducer(state, { type: "googleFailed" }).state).toBe(state);
    expect(accountReducer(state, { type: "googleReturned" }).state).toBe(state);
  });
});

describe("accountFlow — ?notice= from /auth/callback", () => {
  it.each<[string, Notice]>([
    ["staff", "staff"],
    ["deleting", "deletion"],
    ["google_failed", "googleFailed"],
  ])("%s → the email step with its notice, no profile load", (raw, notice) => {
    expect(initialAccount(raw)).toEqual({
      state: { step: "email", email: "", busy: false, notice },
      effects: [],
    });
  });

  it("sign_in_again → clears the dead local session, then 'account ready'", () => {
    const t = initialAccount("sign_in_again");
    expect(t).toEqual({
      state: { step: "email", email: "", busy: true, notice: "accountReady", signingOut: true },
      effects: [{ type: "signOutLocal" }],
    });
    expect(accountReducer(t.state, { type: "signedOut" }).state).toEqual({
      step: "email",
      email: "",
      busy: false,
      notice: "accountReady",
    });
  });

  it("retry_profile → the profile POST, on the existing 503 retry path", () => {
    const t = initialAccount("retry_profile");
    expect(t.state).toEqual({ step: "profileFailed", email: "", busy: true });
    expect(t.effects).toEqual([{ type: "postProfile", attempt: 0, delayMs: 0 }]);
    // Success signs in with the server's email.
    const ok = accountReducer(t.state, { type: "profilePosted", status: 201, attempt: 0, email: "g@b.co" });
    expect(ok.state).toEqual({ step: "signedIn", email: "g@b.co", busy: false });
    // A 503 backs off and retries like a code sign-in.
    const again = accountReducer(t.state, { type: "profilePosted", status: 503, attempt: 0 });
    expect(again.effects).toEqual([{ type: "postProfile", attempt: 1, delayMs: 1000 }]);
    const gaveUp = accountReducer(t.state, { type: "profilePosted", status: 503, attempt: MAX_PROFILE_RETRIES });
    expect(gaveUp.state).toEqual({ step: "profileFailed", email: "", busy: false });
  });

  it.each([[null], [undefined], [""], ["bogus"], ["STAFF"], ["accountReady"], ["__proto__"]])(
    "%s is ignored: the normal profile load",
    (raw) => {
      expect(initialAccount(raw)).toEqual(initialAccount());
    },
  );

  it("noticeFromSearch reads only the notice parameter", () => {
    expect(noticeFromSearch("?notice=staff")).toBe("staff");
    expect(noticeFromSearch("?x=1&notice=google_failed")).toBe("google_failed");
    expect(noticeFromSearch("")).toBeNull();
    expect(noticeFromSearch("?x=1")).toBeNull();
  });

  it("hrefWithoutNotice drops notice and keeps everything else", () => {
    expect(hrefWithoutNotice("https://t.kuunyi.com/account?notice=staff")).toBe("https://t.kuunyi.com/account");
    expect(hrefWithoutNotice("https://t.kuunyi.com/account?a=1&notice=staff#h")).toBe(
      "https://t.kuunyi.com/account?a=1#h",
    );
    expect(hrefWithoutNotice("https://t.kuunyi.com/account?a=1")).toBe("https://t.kuunyi.com/account?a=1");
  });
});

// A dev StrictMode remount runs the mount effect twice; the first transition's
// effects (a profile POST, a sign-out) must still run only once per page.
describe("accountFlow — bootOnce", () => {
  it("hands out the first transition once, then nothing", () => {
    const boot = { started: false };
    const first = initialAccount("retry_profile");
    expect(bootOnce(boot, first)).toBe(first);
    expect(bootOnce(boot, initialAccount("retry_profile"))).toBeNull();
    expect(bootOnce(boot, initialAccount())).toBeNull();
  });

  it("each page gets its own boot", () => {
    expect(bootOnce({ started: false }, initialAccount("sign_in_again"))?.effects).toEqual([{ type: "signOutLocal" }]);
    expect(bootOnce({ started: false }, initialAccount("sign_in_again"))?.effects).toEqual([{ type: "signOutLocal" }]);
  });
});

// ─── ?next=: back to the page that asked for sign-in (Plan 3, Task 11) ──────
// The ticket pages link to /account?next=<url-encoded path>. `next` goes
// through safeNext(); anything it rejects is /account, which means "stay".
describe("accountFlow — ?next= after sign-in", () => {
  const TICKET = "/account/tickets/3f2b8c1e-9d4a-4c6b-a1e2-7f8e9d0c1b2a";

  it("nextFromSearch round-trips an encoded ticket path", () => {
    expect(nextFromSearch(`?next=${encodeURIComponent(TICKET)}`)).toBe(TICKET);
  });

  it("nextFromSearch keeps a query inside next", () => {
    expect(nextFromSearch("?next=/enroll/form?slug=x")).toBe("/enroll/form?slug=x");
    expect(nextFromSearch(`?next=${encodeURIComponent("/enroll/form?slug=x&a=1")}`)).toBe("/enroll/form?slug=x&a=1");
  });

  it.each([
    ["no next", ""],
    ["an empty next", "?next="],
    ["protocol-relative", `?next=${encodeURIComponent("//evil.example")}`],
    ["protocol-relative, raw", "?next=//evil.example/x"],
    ["absolute https", `?next=${encodeURIComponent("https://evil.example/")}`],
    ["backslash", `?next=${encodeURIComponent("/\\x")}`],
    ["javascript:", `?next=${encodeURIComponent("javascript:alert(1)")}`],
    ["double-encoded //", "?next=%252F%252Fevil.example"],
  ])("nextFromSearch falls back to /account for %s", (_n, search) => {
    expect(nextFromSearch(search)).toBe("/account");
  });

  it("a code sign-in ends by navigating to next", () => {
    const ctx = { next: TICKET };
    let t = accountReducer(codeState, { type: "submitCode", code: CODE }, ctx);
    t = accountReducer(t.state, { type: "codeVerified" }, ctx);
    t = accountReducer(t.state, { type: "profilePosted", status: 201, attempt: 0, email: "buyer@example.com" }, ctx);
    expect(t.state).toEqual({ step: "signedIn", email: "buyer@example.com", busy: false });
    expect(t.effects).toEqual([{ type: "goNext", to: TICKET }]);
  });

  it("a code sign-in after a profile retry also navigates to next", () => {
    const ctx = { next: "/enroll/form?slug=x" };
    const failed: AccountState = { step: "profileFailed", email: "buyer@example.com", busy: false };
    let t = accountReducer(failed, { type: "retryProfile" }, ctx);
    t = accountReducer(t.state, { type: "profilePosted", status: 200, attempt: 0, email: "buyer@example.com" }, ctx);
    expect(t.effects).toEqual([{ type: "goNext", to: "/enroll/form?slug=x" }]);
  });

  it("already signed in on load → straight to next", () => {
    const t = accountReducer(
      { step: "loading" },
      { type: "profileLoaded", status: 200, email: "a@b.co" },
      { next: TICKET },
    );
    expect(t.state).toEqual({ step: "signedIn", email: "a@b.co", busy: false });
    expect(t.effects).toEqual([{ type: "goNext", to: TICKET }]);
  });

  it("next of /account (the default, or a rejected next) → stays, no navigation", () => {
    const ok = accountReducer(posting(), { type: "profilePosted", status: 201, attempt: 0, email: "a@b.co" }, { next: "/account" });
    expect(ok.state.step).toBe("signedIn");
    expect(ok.effects).toEqual([]);
    const noCtx = accountReducer(posting(), { type: "profilePosted", status: 201, attempt: 0, email: "a@b.co" });
    expect(noCtx.effects).toEqual([]);
  });

  it("sign_in_again does not navigate; the buyer signs in once more first", () => {
    const t = accountReducer(
      posting(),
      { type: "profilePosted", status: 201, attempt: 0, email: "a@b.co", reason: "sign_in_again" },
      { next: TICKET },
    );
    expect(t.effects).toEqual([{ type: "signOutLocal" }]);
  });

  it("Continue with Google returns to next", () => {
    const t = accountReducer(emailState, { type: "googleClicked" }, { next: TICKET });
    expect(t.effects).toEqual([{ type: "startGoogle", next: TICKET }]);
  });

  it("Google's redirectTo carries next, encoded, through /auth/callback", () => {
    expect(googleRedirectTo("https://t.kuunyi.com", TICKET)).toBe(
      `https://t.kuunyi.com/auth/callback?next=${encodeURIComponent(TICKET)}`,
    );
    expect(googleRedirectTo("https://t.kuunyi.com", "/enroll/form?slug=x&a=1")).toBe(
      "https://t.kuunyi.com/auth/callback?next=%2Fenroll%2Fform%3Fslug%3Dx%26a%3D1",
    );
    // What /auth/callback reads back is the same path.
    const url = new URL(googleRedirectTo("https://t.kuunyi.com", "/enroll/form?slug=x&a=1"));
    expect(url.searchParams.get("next")).toBe("/enroll/form?slug=x&a=1");
  });
});
