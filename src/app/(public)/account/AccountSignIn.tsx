"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { isPasswordSession } from "@/lib/authMethod";
import { isInAppBrowser } from "@/lib/inAppBrowser";
import {
  accountReducer,
  bootOnce,
  hrefWithoutNotice,
  initialAccount,
  noticeFromSearch,
  type AccountEffect,
  type AccountEvent,
  type AccountState,
  type Notice,
  type SessionKind,
} from "./accountFlow";

// ─── /account: buyer sign-in with an email code ─────────────────────────────
//
// Every decision is in accountFlow.ts. This file only runs its effects
// (Supabase Auth, fetch) and renders the state through AccountView.
//
// The code is read from the form on submit and passed straight into the
// reducer, which hands it to the single verifyCode effect. It is never kept in
// React state, put in a URL, or logged; this file logs nothing at all.

// Myanmar text: every `mm` string below is new and needs native review.
type Bilingual = { en: string; mm: string };

const COPY = {
  heading: { en: "My account", mm: "ကျွန်ုပ်၏ အကောင့်" },
  loading: { en: "Loading…", mm: "ခေတ္တစောင့်ပါ…" },
  emailHeading: { en: "Sign in with your email", mm: "သင့်အီးမေးလ်ဖြင့် ဝင်ရောက်ပါ" },
  emailHelp: {
    en: "We'll email you a 6-digit code.",
    mm: "ဂဏန်း ၆ လုံးပါ ကုဒ်ကို သင့်အီးမေးလ်သို့ ပို့ပေးပါမည်။",
  },
  emailLabel: { en: "Email", mm: "အီးမေးလ်" },
  sendCode: { en: "Send code", mm: "ကုဒ် ပို့ရန်" },
  codeHeading: { en: "Enter the code", mm: "ကုဒ်ကို ထည့်ပါ" },
  codeSentTo: { en: "We sent a 6-digit code to", mm: "ဂဏန်း ၆ လုံးပါ ကုဒ်ကို ဤလိပ်စာသို့ ပို့ထားပါသည်" },
  codeLabel: { en: "6-digit code", mm: "ဂဏန်း ၆ လုံး ကုဒ်" },
  verify: { en: "Sign in", mm: "ဝင်ရောက်ရန်" },
  useAnotherEmail: { en: "Use another email", mm: "အခြား အီးမေးလ် သုံးရန်" },
  resend: { en: "Resend code", mm: "ကုဒ် ပြန်ပို့ရန်" },
  signedInAs: { en: "Signed in as", mm: "ဝင်ရောက်ထားသော အကောင့်" },
  signOut: { en: "Sign out", mm: "ထွက်ရန်" },
  tryAgain: { en: "Try again", mm: "ထပ်မံကြိုးစားရန်" },
  sending: { en: "Sending…", mm: "ပို့နေသည်…" },
  checking: { en: "Checking…", mm: "စစ်ဆေးနေသည်…" },
  staffSession: {
    en: "You're signed in as staff on this site. Sign out of the admin, or use another browser, to buy tickets.",
    mm: "ဤဆိုက်တွင် ဝန်ထမ်းအဖြစ် ဝင်ရောက်ထားပါသည်။ လက်မှတ်ဝယ်ရန် admin မှ ထွက်ပါ သို့မဟုတ် အခြား browser ကို သုံးပါ။",
  },
  somethingWrong: {
    en: "Something went wrong. Please try again.",
    mm: "တစ်ခုခု မှားယွင်းနေပါသည်။ ထပ်မံကြိုးစားပါ။",
  },
  // needs native review (every mm string from here to the end of COPY)
  continueWithGoogle: { en: "Continue with Google", mm: "Google ဖြင့် ဆက်လက်ရန်" },
  openingGoogle: { en: "Opening Google…", mm: "Google ကို ဖွင့်နေသည်…" },
  or: { en: "or", mm: "သို့မဟုတ်" },
  inAppBrowser: {
    en: "Google sign-in doesn't work inside this app. Open this page in Chrome or Safari, or use an email code.",
    mm: "ဤ app အတွင်း၌ Google ဖြင့် ဝင်ရောက်၍ မရပါ။ ဤစာမျက်နှာကို Chrome သို့မဟုတ် Safari တွင် ဖွင့်ပါ၊ သို့မဟုတ် အီးမေးလ်ကုဒ်ကို သုံးပါ။",
  },
  copyLink: { en: "Copy link", mm: "လင့်ခ် ကူးယူရန်" },
  linkCopied: { en: "Link copied", mm: "လင့်ခ် ကူးယူပြီးပါပြီ" },
} satisfies Record<string, Bilingual>;

const NOTICES: Record<Notice, Bilingual & { tone: "error" | "info" }> = {
  invalidEmail: {
    tone: "error",
    en: "Enter a valid email address.",
    mm: "မှန်ကန်သော အီးမေးလ်လိပ်စာ ထည့်ပါ။",
  },
  tooManyCodes: {
    tone: "error",
    en: "Too many codes requested. Please try again later.",
    mm: "ကုဒ် တောင်းဆိုမှု များလွန်းပါသည်။ ခဏကြာမှ ပြန်ကြိုးစားပါ။",
  },
  sendFailed: {
    tone: "error",
    en: "We couldn't send the code. Please try again.",
    mm: "ကုဒ် ပို့၍ မရပါ။ ထပ်မံကြိုးစားပါ။",
  },
  codeResent: { tone: "info", en: "We sent a new code.", mm: "ကုဒ်အသစ် ပို့ပြီးပါပြီ။" },
  invalidCode: {
    tone: "error",
    en: "Enter the 6-digit code.",
    mm: "ဂဏန်း ၆ လုံး ကုဒ်ကို ထည့်ပါ။",
  },
  wrongCode: {
    tone: "error",
    en: "That code is wrong or has expired.",
    mm: "ကုဒ် မှားနေပါသည် သို့မဟုတ် သက်တမ်းကုန်သွားပါပြီ။",
  },
  tooManyTries: {
    tone: "error",
    en: "Too many tries. Please wait and try again.",
    mm: "ကြိုးစားမှု များလွန်းပါသည်။ ခဏစောင့်ပြီး ပြန်ကြိုးစားပါ။",
  },
  staff: {
    tone: "error",
    en: "This address belongs to a staff account. Use a different email to buy tickets.",
    mm: "ဤလိပ်စာသည် ဝန်ထမ်းအကောင့် ဖြစ်ပါသည်။ လက်မှတ်ဝယ်ရန် အခြားအီးမေးလ် သုံးပါ။",
  },
  deletion: {
    tone: "error",
    en: "This account is being deleted, so it can't be used to sign in.",
    mm: "ဤအကောင့်ကို ဖျက်နေဆဲ ဖြစ်သောကြောင့် ဝင်ရောက်၍ မရပါ။",
  },
  expired: {
    tone: "error",
    en: "Your sign-in expired. Please sign in again.",
    mm: "ဝင်ရောက်မှု သက်တမ်းကုန်သွားပါပြီ။ ပြန်လည်ဝင်ရောက်ပါ။",
  },
  accountReady: {
    tone: "info",
    en: "Your account is ready. Sign in once more to continue.",
    // needs native review
    mm: "သင့်အကောင့် အဆင်သင့်ဖြစ်ပါပြီ။ ဆက်လက်ရန် နောက်တစ်ကြိမ် ဝင်ရောက်ပါ။",
  },
  googleFailed: {
    tone: "error",
    en: "We couldn't sign you in with Google. Please try again, or use an email code.",
    // needs native review
    mm: "Google ဖြင့် ဝင်ရောက်၍ မရပါ။ ထပ်မံကြိုးစားပါ သို့မဟုတ် အီးမေးလ်ကုဒ်ကို သုံးပါ။",
  },
  generic: {
    tone: "error",
    en: "We couldn't sign you in. Please try again.",
    mm: "ဝင်ရောက်၍ မရပါ။ ထပ်မံကြိုးစားပါ။",
  },
};

// ─── Presentational view (static-rendered in tests) ─────────────────────────

export interface AccountViewProps {
  state: AccountState;
  onSubmitEmail: (email: string) => void;
  onSubmitCode: (code: string) => void;
  onResend: () => void;
  onUseAnotherEmail: () => void;
  onSignOut: () => void;
  onRetryLoad: () => void;
  onRetryProfile: () => void;
  onGoogle: () => void;
  onCopyLink: () => void;
  /** Embedded web view (Messenger, Facebook, …): Google refuses OAuth there. */
  inAppBrowser: boolean;
  /** Copy link just succeeded. */
  linkCopied: boolean;
}

const inputClass =
  "w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-[#1a6b3c] focus:outline-none focus:ring-1 focus:ring-[#1a6b3c] disabled:bg-gray-100";
const primaryButton =
  "w-full rounded-lg bg-[#1a6b3c] px-5 py-3 text-sm font-semibold text-white hover:bg-[#155d33] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const secondaryButton =
  "rounded-lg px-3 py-2 text-sm font-medium text-[#1a6b3c] underline hover:text-[#155d33] disabled:opacity-50 disabled:cursor-not-allowed";

function Text({ copy, className = "" }: { copy: Bilingual; className?: string }) {
  return (
    <>
      <span className={className}>{copy.en}</span>
      <span className={`font-myanmar block ${className}`}>{copy.mm}</span>
    </>
  );
}

function NoticeBox({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const n = NOTICES[notice];
  const tone =
    n.tone === "error"
      ? "border-red-200 bg-red-50 text-red-800"
      : "border-green-200 bg-green-50 text-green-800";
  return (
    <div role={n.tone === "error" ? "alert" : "status"} className={`mb-4 rounded-lg border p-3 text-sm ${tone}`}>
      <p>{n.en}</p>
      <p className="font-myanmar mt-0.5">{n.mm}</p>
    </div>
  );
}

function BusyLabel({ copy }: { copy: Bilingual }) {
  return (
    <>
      {copy.en} / <span className="font-myanmar">{copy.mm}</span>
    </>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">{children}</div>;
}

const googleButton =
  "flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Above the email field: "Continue with Google", or, inside an in-app browser
 * where Google refuses OAuth, why not and a Copy link button.
 */
function GoogleSignIn(props: AccountViewProps & { state: Extract<AccountState, { step: "email" }> }) {
  const { state } = props;
  return (
    <div className="mb-4">
      {props.inAppBrowser ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>{COPY.inAppBrowser.en}</p>
          <p className="font-myanmar mt-0.5">{COPY.inAppBrowser.mm}</p>
          <button type="button" onClick={props.onCopyLink} className={`mt-2 ${secondaryButton}`}>
            {props.linkCopied ? (
              <span role="status">
                {COPY.linkCopied.en} / <span className="font-myanmar">{COPY.linkCopied.mm}</span>
              </span>
            ) : (
              <>
                {COPY.copyLink.en} / <span className="font-myanmar">{COPY.copyLink.mm}</span>
              </>
            )}
          </button>
        </div>
      ) : (
        <button type="button" onClick={props.onGoogle} disabled={state.busy} className={googleButton}>
          {state.google ? (
            <BusyLabel copy={COPY.openingGoogle} />
          ) : (
            <>
              {COPY.continueWithGoogle.en} / <span className="font-myanmar">{COPY.continueWithGoogle.mm}</span>
            </>
          )}
        </button>
      )}
      <p className="mt-4 text-center text-xs uppercase tracking-wide text-gray-400">
        {COPY.or.en} / <span className="font-myanmar normal-case">{COPY.or.mm}</span>
      </p>
    </div>
  );
}

function Body(props: AccountViewProps) {
  const { state } = props;

  switch (state.step) {
    case "loading":
      return (
        <Card>
          <p className="text-center text-sm text-gray-500">
            <Text copy={COPY.loading} />
          </p>
        </Card>
      );

    case "loadFailed":
      return (
        <Card>
          <div role="alert" className="mb-4 text-center text-sm text-gray-700">
            <Text copy={COPY.somethingWrong} />
          </div>
          <button type="button" onClick={props.onRetryLoad} className={primaryButton}>
            {COPY.tryAgain.en} / <span className="font-myanmar">{COPY.tryAgain.mm}</span>
          </button>
        </Card>
      );

    case "staffSession":
      return (
        <Card>
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p>{COPY.staffSession.en}</p>
            <p className="font-myanmar mt-0.5">{COPY.staffSession.mm}</p>
          </div>
          {/* Only a non-password (left-over code) session: a password session
              is their admin session and is never signed out from here. */}
          {state.canSignOut && (
            <button type="button" onClick={props.onSignOut} disabled={state.busy} className={`mt-4 ${primaryButton}`}>
              {COPY.signOut.en} / <span className="font-myanmar">{COPY.signOut.mm}</span>
            </button>
          )}
        </Card>
      );

    case "email": {
      const onSubmit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        props.onSubmitEmail(String(new FormData(e.currentTarget).get("email") ?? ""));
      };
      return (
        <Card>
          <h2 className="text-lg font-semibold text-gray-900">
            <Text copy={COPY.emailHeading} />
          </h2>
          <p className="mb-4 mt-1 text-sm text-gray-600">
            <Text copy={COPY.emailHelp} />
          </p>
          <NoticeBox notice={state.notice} />
          <GoogleSignIn {...props} state={state} />
          <form method="post" onSubmit={onSubmit} noValidate aria-busy={state.busy}>
            <label htmlFor="account-email" className="mb-2 block text-sm font-medium text-gray-700">
              {COPY.emailLabel.en} / <span className="font-myanmar">{COPY.emailLabel.mm}</span>
            </label>
            <input
              id="account-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              defaultValue={state.email}
              // On returning here (Use another email, or after a notice), not
              // on first arrival.
              autoFocus={state.email !== "" || state.notice !== null}
              disabled={state.busy}
              className={inputClass}
            />
            <button type="submit" disabled={state.busy} className={`mt-4 ${primaryButton}`}>
              {state.busy && !state.signingOut && !state.google ? (
                <BusyLabel copy={COPY.sending} />
              ) : (
                <>
                  {COPY.sendCode.en} / <span className="font-myanmar">{COPY.sendCode.mm}</span>
                </>
              )}
            </button>
          </form>
        </Card>
      );
    }

    case "code": {
      const onSubmit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        props.onSubmitCode(String(new FormData(e.currentTarget).get("code") ?? ""));
      };
      return (
        <Card>
          <h2 className="text-lg font-semibold text-gray-900">
            <Text copy={COPY.codeHeading} />
          </h2>
          <p className="mb-4 mt-1 text-sm text-gray-600">
            {COPY.codeSentTo.en} <strong className="break-all">{state.email}</strong>
            <span className="font-myanmar block">{COPY.codeSentTo.mm}</span>
          </p>
          <NoticeBox notice={state.notice} />
          <form method="post" onSubmit={onSubmit} noValidate aria-busy={state.busy}>
            <label htmlFor="account-code" className="mb-2 block text-sm font-medium text-gray-700">
              {COPY.codeLabel.en} / <span className="font-myanmar">{COPY.codeLabel.mm}</span>
            </label>
            <input
              id="account-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              // Room for a pasted "482 913" or "482-913"; the reducer strips
              // spaces and dashes and maps Myanmar digits before checking.
              maxLength={12}
              autoFocus
              required
              disabled={state.busy}
              className={`${inputClass} font-mono tracking-[0.4em]`}
            />
            <button type="submit" disabled={state.busy} className={`mt-4 ${primaryButton}`}>
              {state.busy && !state.resending ? (
                <BusyLabel copy={COPY.checking} />
              ) : (
                <>
                  {COPY.verify.en} / <span className="font-myanmar">{COPY.verify.mm}</span>
                </>
              )}
            </button>
          </form>
          <div className="mt-4 flex flex-wrap justify-between gap-2">
            <button type="button" onClick={props.onUseAnotherEmail} disabled={state.busy} className={secondaryButton}>
              {COPY.useAnotherEmail.en} / <span className="font-myanmar">{COPY.useAnotherEmail.mm}</span>
            </button>
            <button type="button" onClick={props.onResend} disabled={state.busy} className={secondaryButton}>
              {state.resending ? (
                <BusyLabel copy={COPY.sending} />
              ) : (
                <>
                  {COPY.resend.en} / <span className="font-myanmar">{COPY.resend.mm}</span>
                </>
              )}
            </button>
          </div>
        </Card>
      );
    }

    case "profileFailed":
      return (
        <Card>
          <div role="alert" className="mb-4 text-center text-sm text-gray-700">
            <Text copy={COPY.somethingWrong} />
          </div>
          <button type="button" onClick={props.onRetryProfile} disabled={state.busy} className={primaryButton}>
            {COPY.tryAgain.en} / <span className="font-myanmar">{COPY.tryAgain.mm}</span>
          </button>
          <div className="mt-4 text-center">
            <button type="button" onClick={props.onUseAnotherEmail} disabled={state.busy} className={secondaryButton}>
              {COPY.useAnotherEmail.en} / <span className="font-myanmar">{COPY.useAnotherEmail.mm}</span>
            </button>
          </div>
        </Card>
      );

    case "signedIn":
      return (
        <Card>
          <p className="text-sm text-gray-600">
            {COPY.signedInAs.en} / <span className="font-myanmar">{COPY.signedInAs.mm}</span>
          </p>
          <p className="mt-1 break-all text-lg font-semibold text-gray-900">{state.email}</p>
          <button type="button" onClick={props.onSignOut} disabled={state.busy} className={`mt-6 ${primaryButton}`}>
            {COPY.signOut.en} / <span className="font-myanmar">{COPY.signOut.mm}</span>
          </button>
        </Card>
      );
  }
}

export function AccountView(props: AccountViewProps) {
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">{COPY.heading.en}</h1>
        <p className="font-myanmar mt-1 text-gray-600">{COPY.heading.mm}</p>
      </div>
      {/* Keyed by step so each form mounts fresh: the email field picks up its
          default again, and a typed code never survives a step change. */}
      <Body key={props.state.step} {...props} />
    </div>
  );
}

// ─── Effect runner ──────────────────────────────────────────────────────────

const PROFILE_URL = "/api/account/profile";

/** The fields the reducer needs from a profile response; never throws. */
export async function readProfileResponse(res: Response): Promise<{ email?: string; reason?: string }> {
  try {
    const body: unknown = await res.json();
    if (!body || typeof body !== "object") return {};
    const b = body as { email?: unknown; reason?: unknown; error?: { reason?: unknown } };
    // A success body may carry a top-level reason (sign_in_again); an error body carries error.reason.
    const reason = typeof b.error?.reason === "string" ? b.error.reason : typeof b.reason === "string" ? b.reason : undefined;
    return {
      email: typeof b.email === "string" ? b.email : undefined,
      reason,
    };
  } catch {
    return {};
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default function AccountSignIn() {
  // The server render and first paint show "loading"; the mount effect picks
  // the real first transition, since it needs location's ?notice=.
  const stateRef = useRef<AccountState>(initialAccount().state);
  const [state, setState] = useState<AccountState>(stateRef.current);
  /** The first transition has run (kept across a dev StrictMode remount). */
  const boot = useRef({ started: false });
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  const mounted = useRef(true);
  const [inAppBrowser, setInAppBrowser] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const supabase = () => (supabaseRef.current ??= createClient());

  // Declared before dispatch and called through a ref so the two can recurse.
  const runRef = useRef<(effect: AccountEffect) => Promise<void>>(async () => {});

  const dispatch = useCallback((event: AccountEvent) => {
    if (!mounted.current) return;
    const { state: next, effects } = accountReducer(stateRef.current, event);
    stateRef.current = next;
    setState(next);
    for (const effect of effects) void runRef.current(effect);
  }, []);

  runRef.current = async (effect: AccountEffect) => {
    switch (effect.type) {
      case "loadProfile": {
        try {
          const res = await fetch(PROFILE_URL, { credentials: "same-origin", cache: "no-store" });
          const { email } = res.ok ? await readProfileResponse(res) : {};
          dispatch({ type: "profileLoaded", status: res.status, email });
        } catch {
          dispatch({ type: "profileLoaded", status: 0 });
        }
        return;
      }
      case "sendCode": {
        try {
          const { error } = await supabase().auth.signInWithOtp({
            email: effect.email,
            options: { shouldCreateUser: true },
          });
          dispatch(error ? { type: "sendFailed", status: error.status } : { type: "codeSent" });
        } catch {
          dispatch({ type: "sendFailed" });
        }
        return;
      }
      case "verifyCode": {
        try {
          const { error } = await supabase().auth.verifyOtp({
            email: effect.email,
            token: effect.token,
            type: "email",
          });
          dispatch(error ? { type: "verifyFailed", status: error.status } : { type: "codeVerified" });
        } catch {
          dispatch({ type: "verifyFailed" });
        }
        return;
      }
      case "checkSession": {
        // Decodes the local token only, to pick the screen: the server has
        // already refused this session with 403. A failure offers no button.
        let kind: SessionKind = "none";
        try {
          const { data } = await supabase().auth.getSession();
          const token = data.session?.access_token;
          if (token) kind = isPasswordSession(token) ? "password" : "other";
        } catch {
          kind = "none";
        }
        dispatch({ type: "sessionChecked", kind });
        return;
      }
      case "postProfile": {
        if (effect.delayMs > 0) await wait(effect.delayMs);
        // The page may have gone during the back-off.
        if (!mounted.current) return;
        try {
          // No body: the server takes the email from the verified session.
          const res = await fetch(PROFILE_URL, { method: "POST", credentials: "same-origin", cache: "no-store" });
          const { email, reason } = await readProfileResponse(res);
          dispatch({ type: "profilePosted", status: res.status, attempt: effect.attempt, email, reason });
        } catch {
          // A network failure is retried like a 503.
          dispatch({ type: "profilePosted", status: 503, attempt: effect.attempt });
        }
        return;
      }
      case "startGoogle": {
        try {
          // PKCE: @supabase/ssr keeps the verifier in a cookie on this host,
          // and /auth/callback exchanges the code with it. On success the
          // browser leaves this page.
          const { error } = await supabase().auth.signInWithOAuth({
            provider: "google",
            options: {
              redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(effect.next)}`,
            },
          });
          if (error) dispatch({ type: "googleFailed" });
        } catch {
          dispatch({ type: "googleFailed" });
        }
        return;
      }
      case "signOutLocal": {
        try {
          await supabase().auth.signOut({ scope: "local" });
        } catch {
          // Local sign-out clears this tab's storage; nothing to recover here.
        }
        dispatch({ type: "signedOut" });
        return;
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    setInAppBrowser(isInAppBrowser(navigator.userAgent));

    // /auth/callback's ?notice= picks the first screen, then leaves the URL so
    // a reload or a shared link doesn't show it again.
    // Once per page: a remount must not re-read the (now removed) notice, nor
    // start a second profile POST or sign-out.
    if (!boot.current.started) {
      const notice = noticeFromSearch(window.location.search);
      if (notice !== null) {
        window.history.replaceState(window.history.state, "", hrefWithoutNotice(window.location.href));
      }
      const first = bootOnce(boot.current, initialAccount(notice));
      if (first) {
        stateRef.current = first.state;
        setState(first.state);
        for (const effect of first.effects) void runRef.current(effect);
      }
    }

    // Back from Google's page via the back/forward cache: the page is restored
    // still waiting on the redirect, so unlock it.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) dispatch({ type: "googleReturned" });
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      mounted.current = false;
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [dispatch]);

  const copyLink = useCallback(async () => {
    const href = hrefWithoutNotice(window.location.href);
    let copied = false;
    try {
      await navigator.clipboard.writeText(href);
      copied = true;
    } catch {
      // Some in-app browsers have no Clipboard API: fall back to a selection.
      try {
        const field = document.createElement("textarea");
        field.value = href;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        copied = document.execCommand("copy");
        document.body.removeChild(field);
      } catch {
        copied = false;
      }
    }
    if (mounted.current) setLinkCopied(copied);
  }, []);

  return (
    <AccountView
      state={state}
      onSubmitEmail={(email) => dispatch({ type: "submitEmail", email })}
      onSubmitCode={(code) => dispatch({ type: "submitCode", code })}
      onResend={() => dispatch({ type: "resend" })}
      onUseAnotherEmail={() => dispatch({ type: "useAnotherEmail" })}
      onSignOut={() => dispatch({ type: "signOut" })}
      onRetryLoad={() => dispatch({ type: "retryLoad" })}
      onRetryProfile={() => dispatch({ type: "retryProfile" })}
      onGoogle={() => dispatch({ type: "googleClicked" })}
      onCopyLink={() => void copyLink()}
      inAppBrowser={inAppBrowser}
      linkCopied={linkCopied}
    />
  );
}
