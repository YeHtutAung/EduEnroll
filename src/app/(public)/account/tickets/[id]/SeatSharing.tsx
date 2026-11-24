"use client";

import { useCallback, useMemo, useRef, useState, type Ref } from "react";
import type { AccountTicket } from "@/app/api/me/tickets/route";
import { Inline, Text, primaryButton, type Bilingual } from "../TicketList";

// ─── Seat sharing on /account/tickets/[id] (design 6.4, plan 4 Task 11) ─────
//
// SeatSharingView renders a state (static-rendered in tests); the default
// export runs the requests:
//   Share       POST   /api/me/tickets/<id>/share     → { url, expiresAt }
//   Cancel link DELETE /api/me/tickets/<id>/share
//   Give back   POST   /api/me/tickets/<id>/give-back → back to /account/tickets
// A 404 from any of them means the seat can't be shared or given back any
// more: the buttons go and a short line says so.
//
// The share URL carries the link's secret in its fragment. It lives only in
// this component's React state and is shown only in the read-only field right
// after the leader creates it: never in storage, a log, analytics or the page
// URL. A reload forgets it; the leader then sees "Link sent" and can cancel or
// make a new link. This file logs nothing.

// Myanmar text: every `mm` string in this file is new. NEEDS NATIVE REVIEW.
const COPY = {
  share: { en: "Share this seat", mm: "ဤထိုင်ခုံကို မျှဝေရန်" }, // NEEDS NATIVE REVIEW
  shareHelp: {
    en: "Send the link to one friend. They sign in and claim the seat on their own phone.",
    mm: "လင့်ခ်ကို သူငယ်ချင်း တစ်ဦးထံ ပို့ပါ။ ၎င်းတို့ ဝင်ရောက်ပြီး ၎င်းတို့ဖုန်းဖြင့် ထိုင်ခုံကို ရယူနိုင်ပါသည်။", // NEEDS NATIVE REVIEW
  },
  newLinkReplaces: {
    en: "A new link replaces the one you sent.",
    mm: "လင့်ခ်အသစ်သည် ပို့ထားသော လင့်ခ်ကို အစားထိုးပါမည်။", // NEEDS NATIVE REVIEW
  },
  linkSent: { en: "Link sent", mm: "လင့်ခ် ပို့ပြီး" }, // NEEDS NATIVE REVIEW
  shareLink: { en: "Share link", mm: "မျှဝေရန် လင့်ခ်" }, // NEEDS NATIVE REVIEW
  copy: { en: "Copy", mm: "ကူးယူရန်" }, // NEEDS NATIVE REVIEW
  copied: { en: "Copied", mm: "ကူးယူပြီး" }, // NEEDS NATIVE REVIEW
  cancelLink: { en: "Cancel link", mm: "လင့်ခ် ပယ်ဖျက်ရန်" }, // NEEDS NATIVE REVIEW
  sharingCloses: { en: "Sharing closes", mm: "မျှဝေခြင်း ပိတ်မည့်အချိန်" }, // NEEDS NATIVE REVIEW
  yangonTime: { en: "Myanmar time", mm: "မြန်မာစံတော်ချိန်" }, // NEEDS NATIVE REVIEW
  giveBackTo: { en: "Give back to", mm: "ပြန်ပေးရန်" }, // NEEDS NATIVE REVIEW
  confirmGiveBack: {
    en: "Give this seat back? Your QR stops working.",
    mm: "ဤထိုင်ခုံကို ပြန်ပေးမလား။ သင့် QR ကုဒ် အသုံးပြု၍ မရတော့ပါ။", // NEEDS NATIVE REVIEW
  },
  yesGiveBack: { en: "Yes, give it back", mm: "ဟုတ်ကဲ့၊ ပြန်ပေးမည်" }, // NEEDS NATIVE REVIEW
  keep: { en: "Keep it", mm: "ဆက်ထားမည်" }, // NEEDS NATIVE REVIEW
  closed: {
    en: "Sharing has closed for this event.",
    mm: "ဤပွဲအတွက် မျှဝေခြင်း ပိတ်သွားပါပြီ။", // NEEDS NATIVE REVIEW
  },
  gone: {
    en: "This seat can't be shared or given back any more.",
    mm: "ဤထိုင်ခုံကို မျှဝေခြင်း သို့မဟုတ် ပြန်ပေးခြင်း မပြုလုပ်နိုင်တော့ပါ။", // NEEDS NATIVE REVIEW
  },
  tooMany: {
    en: "Too many tries. Try again later.",
    mm: "ကြိုးစားမှု များလွန်းပါသည်။ နောက်မှ ထပ်မံကြိုးစားပါ။", // NEEDS NATIVE REVIEW
  },
  somethingWrong: {
    en: "Something went wrong. Please try again.",
    mm: "တစ်ခုခု မှားယွင်းနေပါသည်။ ထပ်မံကြိုးစားပါ။",
  },
} satisfies Record<string, Bilingual>;

const secondaryButton =
  "inline-block w-full rounded-lg border border-gray-300 bg-white px-5 py-3 text-center text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

/** "19 Dec 2026, 00:00" in Asia/Yangon, as the SQL cutoff is. Display only. */
export function shareClosesLabel(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Yangon" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Yangon" });
  return `${date}, ${time}`;
}

export interface SharingUi {
  /** The share URL, only right after this page created it. Never persisted. */
  url: string | null;
  /** An open link exists: the list's linkOpen, then whatever this page did since. */
  linkOpen: boolean;
  busy: boolean;
  error: "limited" | "generic" | null;
  confirmingGiveBack: boolean;
  copied: boolean;
  /** Share, cancel or give-back answered 404: the seat can't be shared or given back any more. */
  gone: boolean;
}

export const initialSharingUi = (ticket: AccountTicket): SharingUi => ({
  url: null,
  linkOpen: ticket.linkOpen,
  busy: false,
  error: null,
  confirmingGiveBack: false,
  copied: false,
  gone: false,
});

export interface SeatSharingViewProps {
  ticket: AccountTicket;
  ui: SharingUi;
  onShare: () => void;
  onCancelLink: () => void;
  onCopy: () => void;
  onAskGiveBack: () => void;
  onConfirmGiveBack: () => void;
  onKeep: () => void;
  urlInputRef?: Ref<HTMLInputElement>;
  /** Unix seconds; tests pin it. Defaults to the current time. */
  now?: number;
}

function ClosesAt({ at }: { at: number | null }) {
  if (at === null) return null;
  const when = shareClosesLabel(at);
  return (
    <p className="mt-2 text-center text-xs text-gray-500">
      {COPY.sharingCloses.en} {when} ({COPY.yangonTime.en}) /{" "}
      <span className="font-myanmar">
        {COPY.sharingCloses.mm} {when} ({COPY.yangonTime.mm})
      </span>
    </p>
  );
}

function ErrorLine({ error }: { error: SharingUi["error"] }) {
  if (!error) return null;
  return (
    <div role="alert" className="mb-3 text-center text-sm text-red-800">
      <Text copy={error === "limited" ? COPY.tooMany : COPY.somethingWrong} />
    </div>
  );
}

function LeaderSharing(props: SeatSharingViewProps) {
  const { ticket, ui } = props;
  return (
    <>
      <ErrorLine error={ui.error} />
      {ui.url ? (
        <div className="mb-3">
          <label htmlFor="share-link" className="mb-1 block text-xs font-medium text-gray-600">
            <Inline copy={COPY.shareLink} />
          </label>
          <div className="flex gap-2">
            <input
              id="share-link"
              ref={props.urlInputRef}
              type="text"
              readOnly
              value={ui.url}
              autoComplete="off"
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-900"
            />
            <button
              type="button"
              onClick={props.onCopy}
              className="shrink-0 rounded-lg bg-[#1a6b3c] px-4 py-2 text-sm font-semibold text-white hover:bg-[#155d33]"
            >
              {ui.copied ? <Inline copy={COPY.copied} /> : <Inline copy={COPY.copy} />}
            </button>
          </div>
        </div>
      ) : ui.linkOpen ? (
        <p className="mb-3 text-center text-sm font-medium text-gray-800">
          <Inline copy={COPY.linkSent} />
        </p>
      ) : null}
      {ui.linkOpen ? (
        <button type="button" onClick={props.onCancelLink} disabled={ui.busy} className={`mb-2 ${secondaryButton}`}>
          <Inline copy={COPY.cancelLink} />
        </button>
      ) : null}
      {ui.url ? null : (
        <>
          <button type="button" onClick={props.onShare} disabled={ui.busy} className={primaryButton}>
            <Inline copy={COPY.share} />
          </button>
          <p className="mt-2 text-center text-xs text-gray-600">
            <Text copy={ui.linkOpen ? COPY.newLinkReplaces : COPY.shareHelp} />
          </p>
        </>
      )}
      <ClosesAt at={ticket.shareClosesAt} />
    </>
  );
}

function HolderGiveBack(props: SeatSharingViewProps) {
  const { ticket, ui } = props;
  const leader = ticket.leaderEmail ?? "";
  return (
    <>
      <ErrorLine error={ui.error} />
      {ui.confirmingGiveBack ? (
        <>
          <p className="mb-3 text-center text-sm font-medium text-gray-900">
            <Text copy={COPY.confirmGiveBack} />
          </p>
          <button type="button" onClick={props.onConfirmGiveBack} disabled={ui.busy} className={`mb-2 ${primaryButton}`}>
            <Inline copy={COPY.yesGiveBack} />
          </button>
          <button type="button" onClick={props.onKeep} disabled={ui.busy} className={secondaryButton}>
            <Inline copy={COPY.keep} />
          </button>
        </>
      ) : (
        <button type="button" onClick={props.onAskGiveBack} disabled={ui.busy} className={secondaryButton}>
          {COPY.giveBackTo.en} {leader} / <span className="font-myanmar">{leader} {COPY.giveBackTo.mm}</span>
        </button>
      )}
      <ClosesAt at={ticket.shareClosesAt} />
    </>
  );
}

function Note({ copy }: { copy: Bilingual }) {
  return (
    <p className="text-center text-sm text-gray-600">
      <Text copy={copy} />
    </p>
  );
}

export function SeatSharingView(props: SeatSharingViewProps) {
  const { ticket, ui } = props;
  if (ticket.status !== "valid") return null;
  const now = props.now ?? Math.floor(Date.now() / 1000);
  let body;
  if (ui.gone) body = <Note copy={COPY.gone} />;
  else if (ticket.role === "leader" && ticket.canShare) body = <LeaderSharing {...props} />;
  else if (ticket.role === "holder" && ticket.canGiveBack) body = <HolderGiveBack {...props} />;
  // "Closed" only once the cutoff has passed. Other no-action seats (admitted,
  // or a holder whose leader is gone) show nothing.
  else if (ticket.shareClosesAt !== null && now >= ticket.shareClosesAt) body = <Note copy={COPY.closed} />;
  else return null;
  return <div className="mt-4 rounded-lg border border-gray-200 p-4">{body}</div>;
}

// ─── Requests ───────────────────────────────────────────────────────────────

const post = (url: string, method: "POST" | "DELETE") =>
  fetch(url, { method, cache: "no-store", credentials: "same-origin" });

const errorFor = (status: number): SharingUi["error"] => (status === 429 ? "limited" : "generic");

/** A 404 from any of the three: the seat can't be shared or given back any more. */
const GONE: Partial<SharingUi> = {
  busy: false,
  error: null,
  gone: true,
  url: null,
  linkOpen: false,
  confirmingGiveBack: false,
  copied: false,
};

const failed = (status: number): Partial<SharingUi> =>
  status === 404 ? GONE : { busy: false, error: errorFor(status) };

/**
 * The default export's request handlers, separate so tests can drive them
 * without a DOM. `patch` merges into the UI state; `goTo` navigates.
 */
export function sharingRequests(
  ticketId: string,
  patch: (next: Partial<SharingUi>) => void,
  goTo: (href: string) => void = (href) => window.location.assign(href),
) {
  const base = `/api/me/tickets/${encodeURIComponent(ticketId)}`;
  return {
    async share() {
      patch({ busy: true, error: null, copied: false });
      try {
        const res = await post(`${base}/share`, "POST");
        if (!res.ok) return patch(failed(res.status));
        const b = (await res.json()) as { url?: unknown };
        if (typeof b.url !== "string") return patch({ busy: false, error: "generic" });
        patch({ busy: false, url: b.url, linkOpen: true });
      } catch {
        patch({ busy: false, error: "generic" });
      }
    },
    async cancelLink() {
      patch({ busy: true, error: null });
      try {
        const res = await post(`${base}/share`, "DELETE");
        if (!res.ok) return patch(failed(res.status));
        patch({ busy: false, url: null, linkOpen: false, copied: false });
      } catch {
        patch({ busy: false, error: "generic" });
      }
    },
    async giveBack() {
      patch({ busy: true, error: null });
      try {
        const res = await post(`${base}/give-back`, "POST");
        if (!res.ok) return patch({ ...failed(res.status), confirmingGiveBack: false });
        goTo("/account/tickets");
      } catch {
        patch({ busy: false, error: "generic", confirmingGiveBack: false });
      }
    },
  };
}

export default function SeatSharing({ ticket }: { ticket: AccountTicket }) {
  const [ui, setUi] = useState<SharingUi>(() => initialSharingUi(ticket));
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = useCallback((next: Partial<SharingUi>) => setUi((u) => ({ ...u, ...next })), []);
  const requests = useMemo(() => sharingRequests(ticket.id, patch), [ticket.id, patch]);

  const onCopy = useCallback(async () => {
    const field = inputRef.current;
    if (!field) return;
    try {
      await navigator.clipboard.writeText(field.value);
      patch({ copied: true });
    } catch {
      // No clipboard (an insecure context or an in-app webview): select it for a manual copy.
      field.focus();
      field.select();
    }
  }, [patch]);

  return (
    <SeatSharingView
      ticket={ticket}
      ui={ui}
      onShare={() => void requests.share()}
      onCancelLink={() => void requests.cancelLink()}
      onCopy={onCopy}
      onAskGiveBack={() => patch({ confirmingGiveBack: true, error: null })}
      onConfirmGiveBack={() => void requests.giveBack()}
      onKeep={() => patch({ confirmingGiveBack: false })}
      urlInputRef={inputRef}
    />
  );
}
