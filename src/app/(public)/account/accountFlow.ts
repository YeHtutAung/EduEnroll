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
  | "generic";

export type AccountState =
  /** 1. GET /api/account/profile in flight. */
  | { step: "loading" }
  /** 1. The GET failed (503, network, anything unexpected). */
  | { step: "loadFailed" }
  /** 1. 403 on GET: a staff session on this host. Never signed out from here. */
  | { step: "staffSession" }
  /** 2. Email entry. `email` pre-fills the field after "Use another email". */
  | { step: "email"; email: string; busy: boolean; notice: Notice | null }
  /** 3. Code entry for `email`. */
  | { step: "code"; email: string; busy: boolean; notice: Notice | null }
  /** 3. Code accepted, but creating the profile kept failing (503). */
  | { step: "profileFailed"; email: string; busy: boolean }
  /** 4. Signed in. */
  | { step: "signedIn"; email: string; busy: boolean };

export type AccountEffect =
  | { type: "loadProfile" }
  | { type: "sendCode"; email: string }
  | { type: "verifyCode"; email: string; token: string }
  /** attempt 0 is the first POST; 1 and 2 are the retries after a 503. */
  | { type: "postProfile"; attempt: number; delayMs: number }
  | { type: "signOutLocal" };

export type AccountEvent =
  | { type: "profileLoaded"; status: number; email?: string }
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

export function accountReducer(state: AccountState, event: AccountEvent): Transition {
  switch (event.type) {
    // ── 1. Loading ──────────────────────────────────────────────────────────
    case "profileLoaded": {
      if (state.step !== "loading") return stay(state);
      if (event.status === 200 && event.email) {
        return stay({ step: "signedIn", email: event.email, busy: false });
      }
      if (event.status === 401) return stay(emailStep("", null));
      // A staff member already signed in on this host. That session is their
      // admin session: signing it out here would log them out of /admin.
      if (event.status === 403) return stay({ step: "staffSession" });
      return stay({ step: "loadFailed" });
    }

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
      if (state.step === "email" && state.busy) {
        return stay({ step: "code", email: state.email, busy: false, notice: null });
      }
      if (state.step === "code" && state.busy) {
        return stay({ ...state, busy: false, notice: "codeResent" });
      }
      return stay(state);

    case "sendFailed": {
      if ((state.step !== "email" && state.step !== "code") || !state.busy) return stay(state);
      const notice: Notice = event.status === 429 ? "tooManyCodes" : "sendFailed";
      return stay({ ...state, busy: false, notice });
    }

    // ── 3. Code ─────────────────────────────────────────────────────────────
    case "submitCode": {
      if (state.step !== "code" || state.busy) return stay(state);
      const token = event.code.trim();
      if (!CODE_PATTERN.test(token)) return stay({ ...state, notice: "invalidCode" });
      return {
        state: { ...state, busy: true, notice: null },
        effects: [{ type: "verifyCode", email: state.email, token }],
      };
    }

    case "resend":
      if (state.step !== "code" || state.busy) return stay(state);
      return {
        state: { ...state, busy: true, notice: null },
        effects: [{ type: "sendCode", email: state.email }],
      };

    case "useAnotherEmail":
      if (state.step === "code" && !state.busy) return stay(emailStep(state.email, null));
      // The code was accepted here, so a session exists: drop it locally.
      if (state.step === "profileFailed" && !state.busy) {
        return { state: emailStep(state.email, null), effects: [{ type: "signOutLocal" }] };
      }
      return stay(state);

    case "verifyFailed":
      if (state.step !== "code" || !state.busy) return stay(state);
      return stay({
        ...state,
        busy: false,
        notice: event.status === 429 ? "tooManyTries" : "wrongCode",
      });

    case "codeVerified":
      if (state.step !== "code" || !state.busy) return stay(state);
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
        (state.step === "code" || state.step === "profileFailed") && state.busy;
      if (!posting) return stay(state);
      const { email } = state;

      if ((event.status === 200 || event.status === 201) && event.email) {
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
        return {
          state: emailStep("", event.reason === "staff" ? "staff" : "generic"),
          effects: [{ type: "signOutLocal" }],
        };
      }
      if (event.status === 409) {
        return { state: emailStep("", "deletion"), effects: [{ type: "signOutLocal" }] };
      }
      if (event.status === 401) {
        return { state: emailStep(email, "expired"), effects: [{ type: "signOutLocal" }] };
      }
      return { state: emailStep(email, "generic"), effects: [{ type: "signOutLocal" }] };
    }

    // ── 4. Signed in ────────────────────────────────────────────────────────
    case "signOut":
      if (state.step !== "signedIn" || state.busy) return stay(state);
      return { state: { ...state, busy: true }, effects: [{ type: "signOutLocal" }] };

    case "signedOut":
      // Only the Sign out button waits on this. The other local sign-outs have
      // already moved to the email step with their own notice.
      if (state.step === "signedIn" && state.busy) return stay(emailStep("", null));
      return stay(state);

    default:
      return stay(state);
  }
}
