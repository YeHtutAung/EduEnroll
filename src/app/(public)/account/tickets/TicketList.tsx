"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AccountTicket } from "@/app/api/me/tickets/route";

// ─── /account/tickets: the buyer's account tickets on this site ─────────────
//
// TicketListView renders a state (static-rendered in tests); the default export
// only fetches GET /api/me/tickets. The list carries no token, QR or key: each
// ticket's live QR is on /account/tickets/<id>. Logs nothing.

// Myanmar text: every `mm` string in this file is new and needs native review.
export type Bilingual = { en: string; mm: string };

const COPY = {
  heading: { en: "My tickets", mm: "ကျွန်ုပ်၏ လက်မှတ်များ" },
  loading: { en: "Loading…", mm: "ခေတ္တစောင့်ပါ…" },
  signInPrompt: { en: "Sign in to see your tickets.", mm: "သင့်လက်မှတ်များကို ကြည့်ရန် ဝင်ရောက်ပါ။" },
  signIn: { en: "Sign in", mm: "ဝင်ရောက်ရန်" },
  empty: { en: "No account tickets for this event site.", mm: "ဤပွဲဆိုက်အတွက် အကောင့်လက်မှတ် မရှိပါ။" },
  cancelled: { en: "Cancelled", mm: "ပယ်ဖျက်ပြီး" },
  ticket: { en: "Ticket", mm: "လက်မှတ်" },
  phoneLinked: { en: "Phone linked", mm: "ဖုန်းနှင့် ချိတ်ဆက်ထားသည်" },
  open: { en: "Show QR", mm: "QR ပြရန်" },
  somethingWrong: {
    en: "Something went wrong. Please try again.",
    mm: "တစ်ခုခု မှားယွင်းနေပါသည်။ ထပ်မံကြိုးစားပါ။",
  },
  tryAgain: { en: "Try again", mm: "ထပ်မံကြိုးစားရန်" },
  backToAccount: { en: "My account", mm: "ကျွန်ုပ်၏ အကောင့်" },
} satisfies Record<string, Bilingual>;

export const primaryButton =
  "inline-block w-full rounded-lg bg-[#1a6b3c] px-5 py-3 text-center text-sm font-semibold text-white hover:bg-[#155d33] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
export const linkClass = "text-sm font-medium text-[#1a6b3c] underline hover:text-[#155d33]";

export function Text({ copy, className = "" }: { copy: Bilingual; className?: string }) {
  return (
    <>
      <span className={className}>{copy.en}</span>
      <span className={`font-myanmar block ${className}`}>{copy.mm}</span>
    </>
  );
}

export function Inline({ copy }: { copy: Bilingual }) {
  return (
    <>
      {copy.en} / <span className="font-myanmar">{copy.mm}</span>
    </>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">{children}</div>;
}

/** Where the sign-in button goes; `next` takes effect once /account reads it (plan Task 11). */
export const signInHref = (next: string) => `/account?next=${encodeURIComponent(next)}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : value;
}

/** "20 Dec 2026", or "20 Dec 2026 – 21 Dec 2026" for a multi-day event. Fixed format, no locale. */
export function eventDateLabel(eventDate: string | null, endDate: string | null): string | null {
  if (!eventDate) return null;
  const start = formatDay(eventDate);
  if (!endDate) return start;
  const end = formatDay(endDate);
  return end === start ? start : `${start} – ${end}`;
}

export type TicketListState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "error" }
  | { kind: "list"; tickets: AccountTicket[] };

interface EventGroup {
  eventId: string;
  eventName: string;
  dates: string | null;
  tickets: AccountTicket[];
}

/** Grouped by event in the order the API sorted them. */
export function groupByEvent(tickets: AccountTicket[]): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const t of tickets) {
    let g = groups.get(t.eventId);
    if (!g) {
      g = { eventId: t.eventId, eventName: t.eventName, dates: eventDateLabel(t.eventDate, t.endDate), tickets: [] };
      groups.set(t.eventId, g);
    }
    g.tickets.push(t);
  }
  return [...groups.values()];
}

function TicketRow({ t }: { t: AccountTicket }) {
  const label = (
    <div className="min-w-0">
      <p className="font-semibold text-gray-900">
        {t.tier} · {COPY.ticket.en} {t.seatNo}
        <span className="font-myanmar"> / {COPY.ticket.mm} {t.seatNo}</span>
      </p>
      {t.attendeeName ? <p className="truncate text-sm text-gray-600">{t.attendeeName}</p> : null}
      {t.status === "valid" && t.bound ? (
        <p className="mt-0.5 text-xs text-gray-500">
          <Inline copy={COPY.phoneLinked} />
        </p>
      ) : null}
    </div>
  );
  if (t.status === "void") {
    return (
      <li className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4 opacity-75">
        {label}
        <span className="shrink-0 rounded-full bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700">
          <Inline copy={COPY.cancelled} />
        </span>
      </li>
    );
  }
  return (
    <li>
      <a
        href={`/account/tickets/${encodeURIComponent(t.id)}`}
        className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-4 hover:border-[#1a6b3c] hover:bg-green-50 transition-colors"
      >
        {label}
        <span className="shrink-0 text-sm font-semibold text-[#1a6b3c]">
          <Inline copy={COPY.open} /> →
        </span>
      </a>
    </li>
  );
}

function Body({ state, onRetry }: { state: TicketListState; onRetry: () => void }) {
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
          <p className="mb-4 text-center text-sm text-gray-700">
            <Text copy={COPY.signInPrompt} />
          </p>
          <a href={signInHref("/account/tickets")} className={primaryButton}>
            <Inline copy={COPY.signIn} />
          </a>
        </Card>
      );
    case "error":
      return (
        <Card>
          <div role="alert" className="mb-4 text-center text-sm text-gray-700">
            <Text copy={COPY.somethingWrong} />
          </div>
          <button type="button" onClick={onRetry} className={primaryButton}>
            <Inline copy={COPY.tryAgain} />
          </button>
        </Card>
      );
    case "list": {
      if (state.tickets.length === 0) {
        return (
          <Card>
            <p className="text-center text-sm text-gray-600">
              <Text copy={COPY.empty} />
            </p>
          </Card>
        );
      }
      return (
        <div className="space-y-6">
          {groupByEvent(state.tickets).map((g) => (
            <section key={g.eventId}>
              <h2 className="text-lg font-semibold text-gray-900">{g.eventName}</h2>
              {g.dates ? <p className="text-sm text-gray-500">{g.dates}</p> : null}
              <ul className="mt-3 space-y-2">
                {g.tickets.map((t) => (
                  <TicketRow key={t.id} t={t} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      );
    }
  }
}

export function TicketListView({ state, onRetry }: { state: TicketListState; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">{COPY.heading.en}</h1>
        <p className="font-myanmar mt-1 text-gray-600">{COPY.heading.mm}</p>
      </div>
      <Body state={state} onRetry={onRetry} />
      <p className="mt-6 text-center">
        <a href="/account" className={linkClass}>
          <Inline copy={COPY.backToAccount} />
        </a>
      </p>
    </div>
  );
}

/** Reads a GET /api/me/tickets body; anything malformed is null. */
export async function readTicketList(res: Response): Promise<AccountTicket[] | null> {
  try {
    const body: unknown = await res.json();
    const list = (body as { tickets?: unknown } | null)?.tickets;
    return Array.isArray(list) ? (list as AccountTicket[]) : null;
  } catch {
    return null;
  }
}

export default function TicketList() {
  const [state, setState] = useState<TicketListState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      let next: TicketListState;
      try {
        const res = await fetch("/api/me/tickets", { cache: "no-store", credentials: "same-origin" });
        if (res.status === 401) next = { kind: "signedOut" };
        else if (!res.ok) next = { kind: "error" };
        else {
          const tickets = await readTicketList(res);
          next = tickets ? { kind: "list", tickets } : { kind: "error" };
        }
      } catch {
        next = { kind: "error" };
      }
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return <TicketListView state={state} onRetry={retry} />;
}
