import { describe, it, expect } from "vitest";
import {
  accountReducer,
  initialAccount,
  MAX_PROFILE_RETRIES,
  type AccountEvent,
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

  it("403 → staff message WITHOUT signing out (that session is their admin session)", () => {
    const t = accountReducer({ step: "loading" }, { type: "profileLoaded", status: 403 });
    expect(t.state).toEqual({ step: "staffSession" });
    expect(t.effects).toEqual([]);
    expect(t.effects.some((e) => e.type === "signOutLocal")).toBe(false);
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

  it("POST 403 staff → signOutLocal and the staff message", () => {
    const t = accountReducer(posting(), { type: "profilePosted", status: 403, attempt: 0, reason: "staff" });
    expect(t.effects).toEqual([{ type: "signOutLocal" }]);
    expect(t.state).toEqual({ step: "email", email: "", busy: false, notice: "staff" });
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
    expect(t.state).toMatchObject({ step: "email" });
  });

  it("'use another email' from the code step goes back without a sign-out", () => {
    const t = accountReducer(codeState, { type: "useAnotherEmail" });
    expect(t.state).toEqual({ step: "email", email: "buyer@example.com", busy: false, notice: null });
    expect(t.effects).toEqual([]);
  });

  it("resend sends a new code to the same email", () => {
    const [sent, done] = run(codeState, { type: "resend" }, { type: "codeSent" });
    expect(sent.effects).toEqual([{ type: "sendCode", email: "buyer@example.com" }]);
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
