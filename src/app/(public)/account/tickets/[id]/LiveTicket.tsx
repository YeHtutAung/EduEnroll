"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { AccountTicket } from "@/app/api/me/tickets/route";
import { clearToken, deviceKey, k2TextAt, loadToken, saveToken } from "@/lib/tickets/deviceKey";
import { K2_PERIOD_SECONDS, qrSlot, qrTs, secondsLeftAt } from "@/lib/tickets/liveClock";
import { canFallBack, decide, profileStep, type BindOutcome } from "./liveTicketFlow";
import SeatSharing from "./SeatSharing";
import {
  Card,
  Inline,
  Text,
  eventDateLabel,
  linkClass,
  primaryButton,
  readTicketList,
  signInHref,
  type Bilingual,
} from "../TicketList";

// ─── /account/tickets/[id]: the live QR (design 6.1–6.3) ────────────────────
//
// 1. GET /api/account/profile → buyerId (401 → sign in, next = this page).
// 2. deviceKey(buyerId): this browser's non-extractable P-256 key.
// 3. Bind on every load (POST /api/me/tickets/<id>/device), so a rebind
//    elsewhere and the server time are both picked up. 404 → not on this
//    account; 429 / 503 / network → the saved token, if it was bound to this
//    same key.
// 4. Every 15 s, on server-time boundaries, sign k2.<token>.<ts>.<devsig> and
//    draw it. The offset (serverTime − phone time) keeps a wrong phone clock
//    inside the scan window.
//
// The bound token, the device key and the QR text are never logged or shown
// as text. This file logs nothing.

// Myanmar text: every `mm` string in this file is new and needs native review.
const COPY = {
  heading: { en: "My ticket", mm: "ကျွန်ုပ်၏ လက်မှတ်" },
  loading: { en: "Loading your ticket…", mm: "သင့်လက်မှတ်ကို ဖွင့်နေသည်…" },
  signInPrompt: { en: "Sign in to see your ticket.", mm: "သင့်လက်မှတ်ကို ကြည့်ရန် ဝင်ရောက်ပါ။" },
  signIn: { en: "Sign in", mm: "ဝင်ရောက်ရန်" },
  notAvailable: {
    en: "This ticket isn't available on this account.",
    mm: "ဤလက်မှတ်ကို ဤအကောင့်တွင် အသုံးပြု၍ မရပါ။",
  },
  withSomeoneElse: {
    en: "This seat is with someone else now.",
    mm: "ဤထိုင်ခုံသည် ယခု အခြားသူထံတွင် ရှိနေပါသည်။", // NEEDS NATIVE REVIEW
  },
  error: {
    en: "We couldn't load your ticket. Check your connection and try again.",
    mm: "သင့်လက်မှတ်ကို ဖွင့်၍ မရပါ။ အင်တာနက် ချိတ်ဆက်မှုကို စစ်ဆေးပြီး ထပ်မံကြိုးစားပါ။",
  },
  noStorage: {
    en: "This browser can't keep your ticket. Turn off private browsing, or open this page in Chrome or Safari.",
    mm: "ဤ browser တွင် သင့်လက်မှတ်ကို သိမ်းဆည်း၍ မရပါ။ private browsing ကို ပိတ်ပါ သို့မဟုတ် ဤစာမျက်နှာကို Chrome သို့မဟုတ် Safari တွင် ဖွင့်ပါ။",
  },
  tryAgain: { en: "Try again", mm: "ထပ်မံကြိုးစားရန်" },
  stale: {
    en: "Couldn't refresh; showing your saved ticket.",
    mm: "အသစ် ပြန်မရယူနိုင်ပါ၊ သိမ်းထားသော လက်မှတ်ကို ပြသနေပါသည်။",
  },
  keepOpen: {
    en: "Open this page before you arrive and keep it open.",
    mm: "ပွဲသို့ မရောက်မီ ဤစာမျက်နှာကို ဖွင့်ပြီး ဖွင့်ထားပါ။",
  },
  noScreenshot: {
    en: "The QR changes every 15 seconds, so a screenshot won't work at the gate.",
    mm: "QR ကုဒ်သည် ၁၅ စက္ကန့်တိုင်း ပြောင်းသောကြောင့် screenshot ဖြင့် ဝင်၍ မရပါ။",
  },
  homeScreen: {
    en: "Add to Home Screen so this ticket stays on your phone. If you opened this link in Facebook or Messenger, open this page in Safari first.",
    // needs native review
    mm: "ဤလက်မှတ် သင့်ဖုန်းတွင် ဆက်ရှိနေစေရန် Home Screen သို့ ထည့်ပါ။ Facebook သို့မဟုတ် Messenger ထဲတွင် ဖွင့်ထားပါက ဤစာမျက်နှာကို Safari တွင် ဦးစွာ ဖွင့်ပါ။",
  },
  ticket: { en: "Ticket", mm: "လက်မှတ်" },
  signedInAs: { en: "Signed in as", mm: "ဝင်ရောက်ထားသော အကောင့်" },
  allTickets: { en: "All my tickets", mm: "လက်မှတ်များ အားလုံး" },
} satisfies Record<string, Bilingual>;

export type LiveTicketState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "notAvailable"; sharedAway?: boolean }
  | { kind: "noStorage" }
  | { kind: "error" }
  | {
      kind: "ready";
      email: string;
      ticket: AccountTicket | null;
      qrDataUrl: string | null;
      secondsLeft: number;
      notice: "stale" | null;
      showHomeScreenHint: boolean;
    };

export interface LiveTicketViewProps {
  ticketId: string;
  state: LiveTicketState;
  onRetry: () => void;
}

/** iOS (any browser there is WebKit, with Safari's 7-day storage rule) and not a Home Screen app. */
export function shouldShowHomeScreenHint(nav: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
}): boolean {
  const ios =
    /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
  return ios && nav.standalone !== true;
}

/** Re-exported for the view tests; defined in liveClock.ts. */
export { secondsLeftAt };

function Message({ copy, tone = "gray" }: { copy: Bilingual; tone?: "gray" | "red" }) {
  const cls = tone === "red" ? "text-red-800" : "text-gray-700";
  return (
    <div role={tone === "red" ? "alert" : undefined} className={`mb-4 text-center text-sm ${cls}`}>
      <Text copy={copy} />
    </div>
  );
}

function Details({ ticket }: { ticket: AccountTicket }) {
  const dates = eventDateLabel(ticket.eventDate, ticket.endDate);
  return (
    <div className="mb-4 text-center">
      <h2 className="text-lg font-semibold text-gray-900">{ticket.eventName}</h2>
      {dates ? <p className="text-sm text-gray-500">{dates}</p> : null}
      <p className="mt-2 font-semibold text-gray-900">
        {ticket.tier} · {COPY.ticket.en} {ticket.seatNo}
        <span className="font-myanmar"> / {COPY.ticket.mm} {ticket.seatNo}</span>
      </p>
      {ticket.attendeeName ? <p className="text-sm text-gray-700">{ticket.attendeeName}</p> : null}
    </div>
  );
}

function Body({ ticketId, state, onRetry }: LiveTicketViewProps) {
  switch (state.kind) {
    case "loading":
      return (
        <Card>
          <p className="text-center text-sm text-gray-500">
            <Text copy={COPY.loading} />
          </p>
        </Card>
      );
    case "signedOut":
      return (
        <Card>
          <Message copy={COPY.signInPrompt} />
          <a href={signInHref(`/account/tickets/${encodeURIComponent(ticketId)}`)} className={primaryButton}>
            <Inline copy={COPY.signIn} />
          </a>
        </Card>
      );
    case "notAvailable":
      return (
        <Card>
          <Message copy={COPY.notAvailable} />
          {state.sharedAway ? <Message copy={COPY.withSomeoneElse} /> : null}
        </Card>
      );
    case "noStorage":
      return (
        <Card>
          <Message copy={COPY.noStorage} tone="red" />
        </Card>
      );
    case "error":
      return (
        <Card>
          <Message copy={COPY.error} tone="red" />
          <button type="button" onClick={onRetry} className={primaryButton}>
            <Inline copy={COPY.tryAgain} />
          </button>
        </Card>
      );
    case "ready":
      return (
        <Card>
          {state.notice === "stale" ? (
            <div role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <Text copy={COPY.stale} />
            </div>
          ) : null}
          {state.ticket ? <Details ticket={state.ticket} /> : null}
          <div className="mx-auto w-full min-w-[240px] max-w-[300px]">
            {state.qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={state.qrDataUrl}
                alt="Ticket QR code"
                width={300}
                height={300}
                className="block aspect-square h-auto w-full rounded-lg bg-white"
              />
            ) : (
              <div className="aspect-square w-full animate-pulse rounded-lg bg-gray-100" aria-label="Loading QR code" />
            )}
          </div>
          <p className="mt-2 text-center text-xs text-gray-500" aria-live="off">
            QR changes in {state.secondsLeft}s /{" "}
            <span className="font-myanmar">QR ကုဒ် {state.secondsLeft} စက္ကန့်အတွင်း ပြောင်းပါမည်</span>
          </p>
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
            <Text copy={COPY.keepOpen} />
            <p className="mt-2">
              <Text copy={COPY.noScreenshot} />
            </p>
          </div>
          {state.showHomeScreenHint ? (
            <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              <Text copy={COPY.homeScreen} />
            </div>
          ) : null}
          {state.ticket ? <SeatSharing ticket={state.ticket} /> : null}
          <p className="mt-4 text-center text-xs text-gray-500">
            <Inline copy={COPY.signedInAs} />
          </p>
          <p className="break-all text-center text-sm font-medium text-gray-900">{state.email}</p>
        </Card>
      );
  }
}

export function LiveTicketView(props: LiveTicketViewProps) {
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-gray-900">{COPY.heading.en}</h1>
        <p className="font-myanmar mt-1 text-gray-600">{COPY.heading.mm}</p>
      </div>
      <Body {...props} />
      <p className="mt-6 text-center">
        <a href="/account/tickets" className={linkClass}>
          <Inline copy={COPY.allTickets} />
        </a>
      </p>
    </div>
  );
}

// ─── Effect runner ──────────────────────────────────────────────────────────
// Thin: every decision is in liveTicketFlow.ts, the time maths in liveClock.ts.

interface Session {
  pair: CryptoKeyPair;
  token: string;
  jti: string;
  /** Server time = performance.now()/1000 + perfOffset: monotonic for the page's life. */
  perfOffset: number;
}

type Loaded =
  | { kind: "signedOut" | "noStorage" | "error" }
  | { kind: "notAvailable"; sharedAway: boolean }
  | { kind: "ready"; email: string; ticket: AccountTicket | null; session: Session; notice: "stale" | null };

const fetchJson = (url: string, init?: RequestInit) =>
  fetch(url, { cache: "no-store", credentials: "same-origin", ...init });

const perfSeconds = () => performance.now() / 1000;

async function loadDetails(ticketId: string): Promise<AccountTicket | null> {
  try {
    const res = await fetchJson("/api/me/tickets");
    if (!res.ok) return null;
    return (await readTicketList(res))?.find((t) => t.id === ticketId) ?? null;
  } catch {
    return null;
  }
}

/** POST the key; t0/t1 bracket this request alone, so a slow list call can't skew the offset. */
async function bind(ticketId: string, publicKey: string): Promise<BindOutcome> {
  const t0 = perfSeconds();
  let res: Response;
  try {
    res = await fetchJson(`/api/me/tickets/${encodeURIComponent(ticketId)}/device`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey }),
    });
  } catch {
    return { kind: "network" };
  }
  const t1 = perfSeconds();
  const wallAtT1 = Date.now() / 1000;
  if (!res.ok) return { kind: "status", status: res.status };
  try {
    const b = (await res.json()) as { token?: unknown; jti?: unknown; serverTime?: unknown };
    if (
      typeof b.token !== "string" ||
      typeof b.jti !== "string" ||
      typeof b.serverTime !== "number" ||
      !Number.isFinite(b.serverTime)
    ) {
      return { kind: "malformed" };
    }
    return { kind: "ok", token: b.token, jti: b.jti, serverTime: b.serverTime, t0, t1, wallAtT1 };
  } catch {
    return { kind: "malformed" };
  }
}

async function load(ticketId: string): Promise<Loaded> {
  // 1. Who is signed in.
  let buyerId: string;
  let email: string;
  try {
    const res = await fetchJson("/api/account/profile");
    const step = profileStep(res.status);
    if (step !== "ok") return { kind: step };
    const b = (await res.json()) as { buyerId?: unknown; email?: unknown };
    if (typeof b.buyerId !== "string" || typeof b.email !== "string") return { kind: "error" };
    buyerId = b.buyerId;
    email = b.email;
  } catch {
    return { kind: "error" };
  }

  // 2. This browser's key for this buyer.
  let key: { pair: CryptoKeyPair; publicKey: string };
  try {
    key = await deviceKey(buyerId);
  } catch {
    return { kind: "noStorage" };
  }

  // 3. Bind (every load) and the ticket's details, side by side.
  const [ticket, bound] = await Promise.all([loadDetails(ticketId), bind(ticketId, key.publicKey)]);

  const saved = canFallBack(bound) ? await loadToken(buyerId, ticketId).catch(() => undefined) : undefined;
  const d = decide(bound, saved, key.publicKey, { perf: perfSeconds(), wall: Date.now() / 1000 });

  switch (d.kind) {
    case "signedOut":
    case "error":
      return { kind: d.kind };
    case "notAvailable":
      await clearToken(buyerId, ticketId).catch(() => undefined);
      // The bind answers one 404; the list says whether a friend claimed this seat.
      return { kind: "notAvailable", sharedAway: !!ticket?.sharedWith };
    case "ready":
      // A failed save only costs the offline fallback; the QR still works now.
      if (d.save) await saveToken(buyerId, ticketId, d.save).catch(() => undefined);
      return {
        kind: "ready",
        email,
        ticket,
        session: { pair: key.pair, token: d.token, jti: d.jti, perfOffset: d.perfOffset },
        notice: d.notice,
      };
  }
}

export default function LiveTicket({ ticketId }: { ticketId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(K2_PERIOD_SECONDS);
  const [qrFailed, setQrFailed] = useState(false);
  const [homeHint, setHomeHint] = useState(false);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    setHomeHint(
      shouldShowHomeScreenHint({
        userAgent: nav.userAgent,
        platform: nav.platform,
        maxTouchPoints: nav.maxTouchPoints,
        standalone: nav.standalone,
      }),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setQrDataUrl(null);
    setQrFailed(false);
    load(ticketId).then((r) => {
      if (!cancelled) setLoaded(r);
    });
    return () => {
      cancelled = true;
    };
  }, [ticketId, attempt]);

  const session = loaded?.kind === "ready" ? loaded.session : null;
  const slotRef = useRef(-1);

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    slotRef.current = -1;

    const tick = () => {
      // Monotonic: a phone clock correction while the page is open doesn't move the QR.
      const serverNow = perfSeconds() + session.perfOffset;
      setSecondsLeft(secondsLeftAt(serverNow));
      const slot = qrSlot(serverNow);
      if (slot === slotRef.current) return;
      slotRef.current = slot;
      k2TextAt(session.pair, session, qrTs(slot))
        .then((text) => QRCode.toDataURL(text, { width: 300, margin: 1, errorCorrectionLevel: "L" }))
        .then((url) => {
          if (!stopped && slotRef.current === slot) setQrDataUrl(url);
        })
        .catch(() => {
          if (!stopped) setQrFailed(true);
        });
    };

    tick();
    const timer = setInterval(tick, 1000);
    // A phone waking from sleep: redraw at once rather than on the next tick.
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session]);

  let state: LiveTicketState;
  if (!loaded) state = { kind: "loading" };
  else if (loaded.kind === "notAvailable") state = { kind: "notAvailable", sharedAway: loaded.sharedAway };
  else if (loaded.kind !== "ready") state = { kind: loaded.kind };
  else if (qrFailed) state = { kind: "error" };
  else
    state = {
      kind: "ready",
      email: loaded.email,
      ticket: loaded.ticket,
      qrDataUrl,
      secondsLeft,
      notice: loaded.notice,
      showHomeScreenHint: homeHint,
    };

  return <LiveTicketView ticketId={ticketId} state={state} onRetry={retry} />;
}
