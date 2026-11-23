import type { ReactNode, CSSProperties } from "react";
import type { GateState } from "@/lib/enrollment/protectedGate";
import { STAFF_MESSAGE } from "@/lib/enrollment/protectedGate";

// ─── ProtectedGate: what a protected event's form shows before any field ────
//
// A pure view over the gate state (see @/lib/enrollment/protectedGate), so it
// renders the same under renderToStaticMarkup as in the browser.
//
// - open / signedIn: the children, untouched.
// - signedOut: "Sign in to continue" and a link to /account?next=<this page>.
// - staff: the staff message the server answers with.
// - unavailable: the session couldn't be checked; try again.
//
// The sign-in link is a plain <a>: a full page load, never a soft move, so
// nothing from a tracked page carries across documents.
//
// NEEDS NATIVE REVIEW: every Myanmar line in this file is a draft.

export default function ProtectedGate({
  state,
  next,
  children,
}: {
  state: GateState;
  /** The sign-in href, built by accountSignInHref() from the current path and query. */
  next: string;
  children?: ReactNode;
}) {
  if (state === "open" || state === "signedIn") return <>{children}</>;

  if (state === "signedOut") {
    return (
      <div data-protected-gate="signedOut" className="mx-auto max-w-md rounded-xl border border-gray-200 bg-white p-6 text-center">
        <h2 className="text-lg font-semibold text-gray-900">Sign in to continue</h2>
        <p className="font-myanmar mt-1 text-sm text-gray-600">ဆက်လက်ရန် အကောင့်ဖြင့် ဝင်ပါ။</p>
        <p className="mt-3 text-sm text-gray-600">
          Tickets for this event belong to your account. Sign in with your email to buy them.
        </p>
        <a
          href={next}
          className="mt-5 inline-block rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
        >
          Sign in / <span className="font-myanmar">အကောင့်ဝင်ရန်</span>
        </a>
      </div>
    );
  }

  if (state === "staff") {
    return (
      <div data-protected-gate="staff" role="alert" className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-sm font-medium text-red-800">{STAFF_MESSAGE}</p>
        <p className="font-myanmar mt-1 text-sm text-red-700">
          ဝန်ထမ်းအကောင့်ဖြင့် ဤလက်မှတ်များကို ဝယ်ယူ၍ မရပါ။ အခြားအီးမေးလ်ကို အသုံးပြုပါ။
        </p>
      </div>
    );
  }

  return (
    <div data-protected-gate="unavailable" role="alert" className="mx-auto max-w-md rounded-xl border border-gray-200 bg-gray-50 p-6 text-center">
      <p className="text-sm font-medium text-gray-800">We couldn&apos;t check your sign-in. Please try again.</p>
      <p className="font-myanmar mt-1 text-sm text-gray-600">အကောင့်ဝင်ထားမှုကို စစ်ဆေး၍ မရပါ။ ထပ်မံကြိုးစားပါ။</p>
    </div>
  );
}

// ─── The account email, read-only ────────────────────────────────────────────
// On a protected event the order email is the account email (the server
// overwrites it whatever the form says); the field shows it and can't change.

export const ACCOUNT_EMAIL_NOTE = "Tickets are sent to your account.";
export const ACCOUNT_EMAIL_NOTE_MM = "လက်မှတ်များကို သင့်အကောင့်သို့ ပို့ပေးပါမည်။";

export function AccountEmailField({
  email,
  className,
  style,
  noteClassName = "mt-1 text-xs text-gray-500",
  noteStyle,
}: {
  email: string;
  className?: string;
  style?: CSSProperties;
  noteClassName?: string;
  noteStyle?: CSSProperties;
}) {
  return (
    <>
      <input
        type="email"
        value={email}
        readOnly
        aria-readonly="true"
        className={className}
        style={style}
      />
      <p className={noteClassName} style={noteStyle}>
        {ACCOUNT_EMAIL_NOTE}
        <span className="font-myanmar"> · {ACCOUNT_EMAIL_NOTE_MM}</span>
      </p>
    </>
  );
}
