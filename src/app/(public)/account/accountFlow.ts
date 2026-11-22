// ─── /account sign-in: the whole decision table, as a pure reducer ──────────
//
// (state, event) => { state, effects }. Effects are plain descriptions; the
// client component (AccountSignIn.tsx) runs them and feeds the outcome back in
// as events. Nothing here touches Supabase, fetch or the DOM, so every
// transition is unit-tested without a browser.
//
// The sign-in code is never kept in state. It appears in exactly one place:
// the `verifyCode` effect that hands it to Supabase.

export type Notice =
  | "invalidEmail"
  | "tooManyCodes"
  | "sendFailed"
  | "codeResent"
  | "invalidCode"
  | "wrongCode"
  | "tooManyTries"
  | "staff"
  | "deletion"
  | "expired"
  | "accountReady"
  | "generic";

/** What `getSession()` holds on this host, for the staff screen on load. */
export type SessionKind = "password" | "other" | "none";

export type AccountState =
  /** 1. GET /api/account/profile in flight. */
  | { step: "loading" }
  /** 1. The GET failed (503, network, anything unexpected). */
  | { step: "loadFailed" }
  /**
   * 1. 403 on GET: a staff account is signed in on this host. A password
   * session is their admin session and is never signed out from here;
   * `canSignOut` is true only for a non-password (left-over code) session.
   */
  | { step: "staffSession"; canSignOut: boolean; busy: boolean }
  /**
   * 2. Email entry. `email` pre-fills the field after "Use another email".
   * `signingOut`: busy waiting for a local sign-out, not for a send.
   */
  | { step: "email"; email: string; busy: boolean; notice: Notice | null; signingOut?: true }
  /** 3. Code entry for `email`. `resending`: busy on Resend, not on a verify. */
  | { step: "code"; email: string; busy: boolean; notice: Notice | null; resending?: true }
  /** 3. Code accepted, but creating the profile kept failing (503). */
  | { step: "profileFailed"; email: string; busy: boolean }
  /** 4. Signed in. */
  | { step: "signedIn"; email: string; busy: boolean };

export type AccountEffect =
  | { type: "loadProfile" }
  | { type: "checkSession" }
  | { type: "sendCode"; email: string }
  | { type: "verifyCode"; email: string; token: string }
  /** attempt 0 is the first POST; 1 and 2 are the retries after a 503. */
  | { type: "postProfile"; attempt: number; delayMs: number }
  | { type: "signOutLocal" };

export type AccountEvent =
  | { type: "profileLoaded"; status: number; email?: string }
  | { type: "sessionChecked"; kind: SessionKind }
  | { type: "retryLoad" }
  | { type: "submitEmail"; email: string }
  | { type: "codeSent" }
  | { type: "sendFailed"; status?: number }
  | { type: "submitCode"; code: string }
  | { type: "resend" }
  | { type: "useAnotherEmail" }
  | { type: "codeVerified" }
  | { type: "verifyFailed"; status?: number }
  | { type: "profilePosted"; status: number; attempt: number; email?: string; reason?: string }
  | { type: "retryProfile" }
  | { type: "signOut" }
  | { type: "signedOut" };

export interface Transition {
  state: AccountState;
  effects: AccountEffect[];
}

/** Retries after a 503 on POST /api/account/profile. */
export const MAX_PROFILE_RETRIES = 2;
const RETRY_BASE_MS = 1000;

export const CODE_PATTERN = /^\d{6}$/;

export function initialAccount(): Transition {
  return { state: { step: "loading" }, effects: [{ type: "loadProfile" }] };
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Myanmar digits (U+1040–U+1049) become 0–9, and spaces and dashes go, so a
 * code typed on a Myanmar keyboard or pasted as "482 913" still checks.
 */
export function normalizeCode(raw: string): string {
  return raw
    .replace(/[၀-၉]/g, (d) => String(d.charCodeAt(0) - 0x1040))
    .replace(/[\s\-‐-―]/g, "");
}

// Deliberately loose: Supabase validates the address. This only stops an
// obviously empty or malformed field from costing a send.
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const stay = (state: AccountState): Transition => ({ state, effects: [] });

const emailStep = (email: string, notice: Notice | null): AccountState => ({
  step: "email",
  email,
  busy: false,
  notice,
});

/**
 * Back to the email step behind a local sign-out. Stays busy until
 * `signedOut` arrives, so a new sign-in can't start and then be cleared by
 * the late sign-out.
 */
const signOutToEmail = (email: string, notice: Notice | null): Transition => ({
  state: { step: "email", email, busy: true, notice, signingOut: true },
  effects: [{ type: "signOutLocal" }],
});

export function accountReducer(state: AccountState, event: AccountEvent): Transition {
  switch (event.type) {
    // ── 1. Loading ──────────────────────────────────────────────────────────
    case "profileLoaded": {
      if (state.step !== "loading") return stay(state);
      if (event.status === 200 && event.email) {
        return stay({ step: "signedIn", email: event.email, busy: false });
      }
      if (event.status === 401) return stay(emailStep("", null));
      // A staff account is already signed in on this host. If that is their
      // password (admin) session, signing it out here would log them out of
      // /admin, so first ask what kind of session it is.
      if (event.status === 403) {
        return {
          state: { step: "staffSession", canSignOut: false, busy: false },
          effects: [{ type: "checkSession" }],
        };
      }
      return stay({ step: "loadFailed" });
    }

    case "sessionChecked":
      if (state.step !== "staffSession" || state.busy) return stay(state);
      return stay({ ...state, canSignOut: event.kind === "other" });

    case "retryLoad":
      if (state.step !== "loadFailed") return stay(state);
      return initialAccount();

    // ── 2. Email ────────────────────────────────────────────────────────────
    case "submitEmail": {
      if (state.step !== "email" || state.busy) return stay(state);
      const email = normalizeEmail(event.email);
      if (!looksLikeEmail(email)) {
        return stay({ ...state, email, notice: "invalidEmail" });
      }
      return {
        state: { step: "email", email, busy: true, notice: null },
        effects: [{ type: "sendCode", email }],
      };
    }

    case "codeSent":
      if (state.step === "email" && state.busy && !state.signingOut) {
        return stay({ step: "code", email: state.email, busy: false, notice: null });
      }
      if (state.step === "code" && state.busy && state.resending) {
        return stay({ step: "code", email: state.email, busy: false, notice: "codeResent" });
      }
      return stay(state);

    case "sendFailed": {
      const notice: Notice = event.status === 429 ? "tooManyCodes" : "sendFailed";
      if (state.step === "email" && state.busy && !state.signingOut) {
        return stay({ step: "email", email: state.email, busy: false, notice });
      }
      if (state.step === "code" && state.busy && state.resending) {
        return stay({ step: "code", email: state.email, busy: false, notice });
      }
      return stay(state);
    }

    // ── 3. Code ─────────────────────────────────────────────────────────────
    case "submitCode": {
      if (state.step !== "code" || state.busy) return stay(state);
      const token = normalizeCode(event.code);
      if (!CODE_PATTERN.test(token)) return stay({ ...state, notice: "invalidCode" });
      return {
        state: { step: "code", email: state.email, busy: true, notice: null },
        effects: [{ type: "verifyCode", email: state.email, token }],
      };
    }

    case "resend":
      if (state.step !== "code" || state.busy) return stay(state);
      return {
        state: { step: "code", email: state.email, busy: true, notice: null, resending: true },
        effects: [{ type: "sendCode", email: state.email }],
      };

    case "useAnotherEmail":
      if (state.step === "code" && !state.busy) return stay(emailStep(state.email, null));
      // The code was accepted here, so a session exists: drop it locally.
      if (state.step === "profileFailed" && !state.busy) return signOutToEmail(state.email, null);
      return stay(state);

    case "verifyFailed":
      if (state.step !== "code" || !state.busy || state.resending) return stay(state);
      return stay({
        ...state,
        busy: false,
        notice: event.status === 429 ? "tooManyTries" : "wrongCode",
      });

    case "codeVerified":
      if (state.step !== "code" || !state.busy || state.resending) return stay(state);
      return {
        state,
        effects: [{ type: "postProfile", attempt: 0, delayMs: 0 }],
      };

    case "retryProfile":
      if (state.step !== "profileFailed" || state.busy) return stay(state);
      return {
        state: { ...state, busy: true },
        effects: [{ type: "postProfile", attempt: 0, delayMs: 0 }],
      };

    case "profilePosted": {
      const posting =
        (state.step === "code" && state.busy && !state.resending) ||
        (state.step === "profileFailed" && state.busy);
      if (!posting) return stay(state);
      const { email } = state;

      if ((event.status === 200 || event.status === 201) && event.email) {
        // The profile exists, but the server couldn't re-issue the session its
        // password reset ended (Task 11a): clear the dead local session and
        // ask for one more sign-in, the address kept.
        if (event.reason === "sign_in_again") return signOutToEmail(event.email, "accountReady");
        return stay({ step: "signedIn", email: event.email, busy: false });
      }
      if (event.status === 503) {
        if (event.attempt < MAX_PROFILE_RETRIES) {
          const attempt = event.attempt + 1;
          return {
            state,
            effects: [
              { type: "postProfile", attempt, delayMs: RETRY_BASE_MS * 2 ** (attempt - 1) },
            ],
          };
        }
        return stay({ step: "profileFailed", email, busy: false });
      }
      // The code session was made a moment ago by this page, so signing it out
      // locally loses nothing else. (Contrast the 403 on load, above.)
      if (event.status === 403) {
        return signOutToEmail("", event.reason === "staff" ? "staff" : "generic");
      }
      if (event.status === 409) return signOutToEmail("", "deletion");
      if (event.status === 401) return signOutToEmail(email, "expired");
      // Anything else, including a 200/201 without an email, is not trusted.
      return signOutToEmail(email, "generic");
    }

    // ── 4. Signed in (and the staff screen's left-over code session) ───────
    case "signOut":
      if (state.step === "signedIn" && !state.busy) return signOutToEmail("", null);
      if (state.step === "staffSession" && state.canSignOut && !state.busy) {
        return signOutToEmail("", null);
      }
      return stay(state);

    case "signedOut":
      if (state.step === "email" && state.signingOut) {
        return stay(emailStep(state.email, state.notice));
      }
      return stay(state);

    default:
      return stay(state);
  }
}
