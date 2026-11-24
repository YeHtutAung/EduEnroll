"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Card,
  Inline,
  Text,
  eventDateLabel,
  linkClass,
  primaryButton,
  signInHref,
  type Bilingual,
} from "@/app/(public)/account/tickets/TicketList";
import {
  decide,
  finishClaim,
  readClaimToken,
  readPreview,
  submitClaim,
  takeClaimToken,
  type ClaimSeatState,
} from "./claimFlow";

// ─── /t/claim: a friend claims a shared seat (plan 4, Task 12) ──────────────
//
// ClaimSeatView renders a state (static-rendered in tests) and is never handed
// the token. The default export reads the token that STRIP_FRAGMENT_JS stored
// (running the same strip as a backup if the fragment is still there),
// previews the seat, and claims it on "Claim this seat". The token is sent
// only to the two claim endpoints and forgotten as soon as the claim answers,
// except a 401, which keeps it for the sign-in round trip (or as soon as the
// preview says the link no longer works). Logs nothing.

// Myanmar text: every `mm` string in this file is new. NEEDS NATIVE REVIEW.
const COPY = {
  heading: { en: "Claim a seat", mm: "ထိုင်ခုံ ရယူရန်" },
  loading: { en: "Loading…", mm: "ခေတ္တစောင့်ပါ…" },
  ticket: { en: "Ticket", mm: "လက်မှတ်" },
  claim: { en: "Claim this seat", mm: "ဤထိုင်ခုံကို ရယူမည်" },
  claiming: { en: "Claiming…", mm: "ရယူနေသည်…" },
  signInTitle: { en: "Sign in to claim this seat", mm: "ဤထိုင်ခုံကို ရယူရန် ဝင်ရောက်ပါ" },
  signIn: { en: "Sign in", mm: "ဝင်ရောက်ရန်" },
  explain: {
    en: "Sign in with the email you want this seat on. The seat moves to your account and works only on your phone.",
    mm: "ဤထိုင်ခုံကို ထားလိုသော အီးမေးလ်ဖြင့် ဝင်ရောက်ပါ။ ထိုင်ခုံသည် သင့်အကောင့်သို့ ပြောင်းရွှေ့သွားပြီး သင့်ဖုန်းတွင်သာ အသုံးပြုနိုင်ပါမည်။",
  },
  gone: { en: "This link no longer works.", mm: "ဤလင့်ခ်ကို အသုံးပြု၍ မရတော့ပါ။" },
  goneHelp: {
    en: "Ask the person who shared it for a new link. If you shared it, it's still your seat.",
    mm: "မျှဝေပေးသူထံမှ လင့်ခ်အသစ် တောင်းပါ။ ဤလင့်ခ်ကို သင်ကိုယ်တိုင် မျှဝေခဲ့ပါက ထိုင်ခုံသည် သင့်ထံတွင်သာ ရှိနေဆဲဖြစ်ပါသည်။",
  },
  noToken: {
    en: "Open the link again from the message you received.",
    mm: "သင်လက်ခံရရှိသော မက်ဆေ့ချ်ထဲမှ လင့်ခ်ကို ပြန်ဖွင့်ပါ။", // NEEDS NATIVE REVIEW
  },
  limited: { en: "Too many tries. Try again later.", mm: "ကြိုးစားမှု များလွန်းပါသည်။ နောက်မှ ထပ်မံကြိုးစားပါ။" },
  somethingWrong: {
    en: "Something went wrong. Please try again.",
    mm: "တစ်ခုခု မှားယွင်းနေပါသည်။ ထပ်မံကြိုးစားပါ။",
  },
  reopenLink: { en: "Open the link again to try again.", mm: "ထပ်မံကြိုးစားရန် လင့်ခ်ကို ပြန်ဖွင့်ပါ။" },
  tryAgain: { en: "Try again", mm: "ထပ်မံကြိုးစားရန်" },
  myTickets: { en: "My tickets", mm: "ကျွန်ုပ်၏ လက်မှတ်များ" },
} satisfies Record<string, Bilingual>;

function Problem({ copy, canRetry, onRetry }: { copy: Bilingual; canRetry: boolean; onRetry: () => void }) {
  return (
    <Card>
      <div role="alert" className="mb-4 text-center text-sm text-gray-700">
        <Text copy={copy} />
      </div>
      {canRetry ? (
        <button type="button" onClick={onRetry} className={primaryButton}>
          <Inline copy={COPY.tryAgain} />
        </button>
      ) : (
        <p className="text-center text-sm text-gray-600">
          <Text copy={COPY.reopenLink} />
        </p>
      )}
    </Card>
  );
}

function Body({ state, onClaim, onRetry }: { state: ClaimSeatState; onClaim: () => void; onRetry: () => void }) {
  switch (state.kind) {
    case "loading":
      return (
        <Card>
          <p className="text-center text-sm text-gray-500">
            <Text copy={COPY.loading} />
          </p>
        </Card>
      );
    case "ready": {
      const { preview, claiming } = state;
      const date = eventDateLabel(preview.eventDate, null);
      return (
        <Card>
          <h2 className="text-lg font-semibold text-gray-900">{preview.eventName}</h2>
          {date ? <p className="text-sm text-gray-500">{date}</p> : null}
          <p className="mt-3 font-semibold text-gray-900">
            {preview.tier} · {COPY.ticket.en} {preview.seatNo}
            <span className="font-myanmar"> / {COPY.ticket.mm} {preview.seatNo}</span>
          </p>
          <p className="mt-4 mb-4 text-sm text-gray-700">
            <Text copy={COPY.explain} />
          </p>
          <button type="button" onClick={onClaim} disabled={claiming} className={primaryButton}>
            <Inline copy={claiming ? COPY.claiming : COPY.claim} />
          </button>
        </Card>
      );
    }
    case "signIn":
      return (
        <Card>
          <p className="mb-2 text-center font-semibold text-gray-900">
            <Text copy={COPY.signInTitle} />
          </p>
          <p className="mb-4 text-center text-sm text-gray-700">
            <Text copy={COPY.explain} />
          </p>
          <a href={signInHref("/t/claim")} className={primaryButton}>
            <Inline copy={COPY.signIn} />
          </a>
        </Card>
      );
    case "gone":
      return (
        <Card>
          <p className="mb-2 text-center font-semibold text-gray-900">
            <Text copy={COPY.gone} />
          </p>
          <p className="text-center text-sm text-gray-700">
            <Text copy={COPY.goneHelp} />
          </p>
        </Card>
      );
    case "noToken":
      return (
        <Card>
          <p className="text-center text-sm text-gray-700">
            <Text copy={COPY.noToken} />
          </p>
        </Card>
      );
    case "limited":
      return <Problem copy={COPY.limited} canRetry={state.canRetry} onRetry={onRetry} />;
    case "error":
      return <Problem copy={COPY.somethingWrong} canRetry={state.canRetry} onRetry={onRetry} />;
  }
}

export function ClaimSeatView({
  state,
  onClaim,
  onRetry,
}: {
  state: ClaimSeatState;
  onClaim: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">{COPY.heading.en}</h1>
        <p className="font-myanmar mt-1 text-gray-600">{COPY.heading.mm}</p>
      </div>
      <Body state={state} onClaim={onClaim} onRetry={onRetry} />
      <p className="mt-6 text-center">
        <a href="/account/tickets" className={linkClass}>
          <Inline copy={COPY.myTickets} />
        </a>
      </p>
    </div>
  );
}

const postToken = (url: string, token: string) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    cache: "no-store",
    credentials: "same-origin",
  });

export default function ClaimSeat() {
  const [state, setState] = useState<ClaimSeatState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Preview: what the seat is, or why the link can't be claimed.
  useEffect(() => {
    let cancelled = false;
    // Backup strip: if the inline script didn't run (a client-side render),
    // the fragment is still in the URL; take it out before reading the token.
    const token = takeClaimToken();
    if (!token) {
      setState({ kind: "noToken" });
      return;
    }
    setState({ kind: "loading" });
    (async () => {
      let next: ClaimSeatState;
      try {
        const res = await postToken("/api/me/tickets/claim/preview", token);
        switch (decide(res.status)) {
          case "ready": {
            const preview = readPreview(await res.json().catch(() => null));
            next = preview ? { kind: "ready", preview, claiming: false } : { kind: "error", canRetry: true };
            break;
          }
          case "signIn":
            // The token stays stored across the sign-in; /account sends the buyer back here.
            next = { kind: "signIn" };
            break;
          case "gone":
            finishClaim();
            next = { kind: "gone" };
            break;
          case "limited":
            next = { kind: "limited", canRetry: true };
            break;
          default:
            next = { kind: "error", canRetry: true };
        }
      } catch {
        next = { kind: "error", canRetry: true };
      }
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const claim = useCallback(async () => {
    if (busy.current || state.kind !== "ready") return;
    const token = readClaimToken();
    if (!token) {
      setState({ kind: "noToken" });
      return;
    }
    busy.current = true;
    setState({ ...state, claiming: true });
    // No answer or 401 keeps the token (retry / sign-in); any other answer forgets it.
    const result = await submitClaim(token, postToken);
    if ("redirect" in result) {
      window.location.replace(result.redirect);
      return;
    }
    busy.current = false;
    setState(result.state);
  }, [state]);

  return <ClaimSeatView state={state} onClaim={() => void claim()} onRetry={retry} />;
}
