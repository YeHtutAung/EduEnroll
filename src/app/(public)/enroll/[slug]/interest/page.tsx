"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { TenantAppearance } from "@/types/database";
import { DEFAULT_APPEARANCE } from "@/types/database";
import BrandHeader from "@/components/enrollment/BrandHeader";

// ─── Register interest in an event's priority window ────────────────────────
//
// Reached only from the CTA on `[slug]/page.tsx`, which shows it exclusively
// while `priority_open_at` is set and still in the future and at least one
// tier is still covered. This page re-derives the same two conditions from
// its own fetch of GET /api/public/enroll/[slug] before rendering the form,
// because the CTA can go stale: someone can leave the tab open past the
// window opening, or load this URL directly from a saved link.
//
// POST /api/public/interest is the write path — see that route's docblock for
// the exact contract. This page never fabricates a token: the raw value is
// shown ONLY when the response includes one (first signup), and a repeat
// signup is told its link was emailed, never shown one.

// ─── Types ────────────────────────────────────────────────────────────────────

interface PublicClass {
  id: string;
  level: string;
}

interface PublicIntake {
  id: string;
  name: string;
  year: number;
  status: string;
  priority_open_at?: string | null;
}

interface TenantLabels {
  orgType: string;
}

interface ApiResponse {
  intake: PublicIntake;
  classes: PublicClass[];
  labels?: TenantLabels;
  appearance?: Omit<TenantAppearance, "id" | "tenant_id" | "updated_at">;
  school_name?: string;
  priority_covered_class_ids?: string[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable" } // fetched fine, but the window is not (or no longer) open for signup
  | {
      kind: "ready";
      intakeId: string;
      intakeName: string;
      slug: string;
      windowOpensAt: string;
      coveredLevels: string[];
      primaryColor: string;
      logoUrl: string | null;
      schoolName: string;
    };

type SubmitResult =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "success"; emailed: boolean; token: string | null; link: string | null };

// ─── Page shell ──────────────────────────────────────────────────────────────

function PageWrapper({
  schoolName,
  primaryColor,
  logoUrl,
  children,
}: {
  schoolName: string;
  primaryColor: string;
  logoUrl: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white">
      {schoolName && <BrandHeader schoolName={schoolName} primaryColor={primaryColor} logoUrl={logoUrl} />}
      <main className="mx-auto max-w-xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

function BarePageWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-6 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}

// ─── Loading / error / unavailable states ────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="mx-auto mb-6 h-6 w-56 rounded bg-gray-200" />
      <div className="mx-auto mb-8 h-4 w-72 rounded bg-gray-100" />
      <div className="mx-auto max-w-md space-y-5">
        {[1, 2, 3].map((i) => (
          <div key={i}>
            <div className="mb-2 h-4 w-32 rounded bg-gray-200" />
            <div className="h-10 rounded-lg bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, slug }: { message: string; slug: string }) {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50">
        <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <h2 className="mb-2 text-xl font-semibold text-gray-900">Something went wrong</h2>
      <p className="max-w-sm text-sm text-gray-500">{message}</p>
      <a href={`/enroll/${slug}`} className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-[#1a3f8a] hover:underline">
        ← Back to event page
      </a>
    </div>
  );
}

function UnavailableState({ slug }: { slug: string }) {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
        <span className="text-3xl">🎟</span>
      </div>
      <h1 className="text-xl font-bold text-gray-900">Priority signup isn&apos;t open right now</h1>
      <p className="font-myanmar mt-1 text-base text-gray-600">
        ဦးစားပေးအခွင့်အရေး စာရင်းသွင်းမှု ယခုအချိန်တွင် မရနိုင်ပါ
      </p>
      <p className="mt-4 max-w-sm text-sm text-gray-500">
        Either the head start window has already opened, or every ticket for this event is already
        on public sale. Head back to the event page to enroll directly.
      </p>
      <a href={`/enroll/${slug}`} className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-[#1a3f8a] hover:underline">
        ← Go to event page
      </a>
    </div>
  );
}

// ─── Copy helpers ─────────────────────────────────────────────────────────────

function formatOpensAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function joinLevels(levels: string[]): string {
  if (levels.length === 1) return levels[0];
  if (levels.length === 2) return `${levels[0]} and ${levels[1]}`;
  return `${levels.slice(0, -1).join(", ")}, and ${levels[levels.length - 1]}`;
}

// ─── Success panel ────────────────────────────────────────────────────────────

function SuccessPanel({
  result,
  primaryColor,
}: {
  result: Extract<SubmitResult, { kind: "success" }>;
  primaryColor: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    if (!result.link) return;
    try {
      await navigator.clipboard.writeText(result.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available — the link is still selectable on screen */
    }
  }

  // First signup: a live link to show. Repeat signup: no token was returned,
  // so there is nothing here to display — see the route's docblock on why
  // echoing a token back on a repeat would let anyone harvest someone else's
  // link by typing their address into this form.
  if (result.token && result.link) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <h2 className="text-lg font-semibold text-emerald-900">You&apos;re on the list</h2>
        <p className="font-myanmar mt-1 text-sm text-emerald-800">စာရင်းသွင်းပြီးပါပြီ</p>

        {!result.emailed && (
          <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3">
            <p className="text-sm font-semibold text-red-800">
              We could not email this link to you. The link below is your only copy — save it now.
            </p>
            <p className="font-myanmar mt-1 text-xs text-red-700">
              ဤလင့်ခ်ကို အီးမေးလ်ဖြင့် ပို့၍မရပါ။ အောက်ပါလင့်ခ်သည် သင့်တစ်ခုတည်းသော မိတ္တူဖြစ်သောကြောင့် ယခုပင် သိမ်းဆည်းပါ။
            </p>
          </div>
        )}
        {result.emailed && (
          <p className="mt-3 text-sm text-emerald-800">
            We&apos;ve also emailed you this link, in case you need it later.
          </p>
        )}

        <p className="mt-4 text-sm font-medium text-emerald-900">
          Save this link — you&apos;ll need it when the window opens:
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={result.link}
            onFocus={(e) => e.target.select()}
            className="min-w-0 flex-1 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm text-gray-900"
          />
          <button
            onClick={copyLink}
            className="shrink-0 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: primaryColor }}
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
        <p className="mt-3 text-xs text-emerald-700">
          Clicking this link now won&apos;t do anything special yet — the page will just show its
          normal &quot;opens on&quot; state until the window starts. That&apos;s expected, not a broken link.
        </p>
      </div>
    );
  }

  // Repeat signup.
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
      <h2 className="text-lg font-semibold text-emerald-900">You&apos;re already on the list</h2>
      <p className="font-myanmar mt-1 text-sm text-emerald-800">
        သင့်အမည်ကို စာရင်းသွင်းပြီးဖြစ်သည်
      </p>
      {result.emailed ? (
        <>
          <p className="mt-3 text-sm text-emerald-800">
            We&apos;ve emailed your priority-access link again. Please check your inbox (and spam folder).
          </p>
          <p className="font-myanmar mt-1 text-xs text-emerald-700">
            သင့်ဦးစားပေးလင့်ခ်ကို ထပ်မံပို့ပေးလိုက်ပါပြီ။ သင်၏ အီးမေးလ်ကို စစ်ဆေးပါ။
          </p>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm font-semibold text-red-700">
            We could not send the email just now. Please try again in a few minutes.
          </p>
          <p className="font-myanmar mt-1 text-xs text-red-700">
            အီးမေးလ်ပို့ရာတွင် မအောင်မြင်ပါ။ မိနစ်အနည်းငယ်အကြာတွင် ထပ်မံကြိုးစားပါ။
          </p>
        </>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function InterestSignupPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [hp, setHp] = useState("");
  const [submit, setSubmit] = useState<SubmitResult>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/public/enroll/${slug}`);
        const body: ApiResponse & { error?: string } = await res.json().catch(() => ({}) as ApiResponse);
        if (cancelled) return;

        if (!res.ok) {
          // >=500 is an outage, not a real "nothing to sign up for" state —
          // telling the visitor the window already closed would be false.
          // Everything else (404 NOT_FOUND, 410 DRAFT/CLOSED) genuinely means
          // there is nothing here to register interest in right now.
          if (res.status >= 500) {
            setState({ kind: "error", message: "Failed to load event details. Please try again." });
          } else {
            setState({ kind: "unavailable" });
          }
          return;
        }

        const priorityOpenAt = body.intake.priority_open_at;
        const coveredIds = body.priority_covered_class_ids ?? [];
        const stillOpen = !!priorityOpenAt && Date.parse(priorityOpenAt) > Date.now();

        if (!stillOpen || coveredIds.length === 0) {
          setState({ kind: "unavailable" });
          return;
        }

        const coveredLevels = Array.from(
          new Set(body.classes.filter((c) => coveredIds.includes(c.id)).map((c) => c.level)),
        );
        const appearance = body.appearance ?? DEFAULT_APPEARANCE;

        setState({
          kind: "ready",
          intakeId: body.intake.id,
          intakeName: body.intake.name,
          slug,
          windowOpensAt: priorityOpenAt as string,
          coveredLevels,
          primaryColor: appearance.primary_color || "#2563eb",
          logoUrl: appearance.logo_url ?? null,
          schoolName: body.school_name ?? "",
        });
      } catch {
        if (!cancelled) setState({ kind: "error", message: "Failed to load event details. Please try again." });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function handleSubmit(e: React.FormEvent, intakeId: string) {
    e.preventDefault();
    if (submit.kind === "submitting") return;

    if (!name.trim() || !email.trim()) {
      setSubmit({ kind: "error", message: "Name and email are required." });
      return;
    }

    setSubmit({ kind: "submitting" });

    try {
      const res = await fetch("/api/public/interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intake_id: intakeId,
          name: name.trim(),
          email: email.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(hp ? { __hp: hp } : {}),
        }),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // See src/app/api/public/interest/route.ts for the exact code set.
        const message =
          body.code === "PRIORITY_WINDOW_OPEN"
            ? "The priority window for this event has just opened — head start signups are now closed. You can still enroll on the event page."
            : body.code === "PRIORITY_WINDOW_UNSET" || body.code === "NO_GATED_TIERS"
            ? "This event no longer has a priority window open for signup."
            : body.code === "INTAKE_UNAVAILABLE"
            ? "This event is no longer accepting interest."
            : res.status === 503
            ? "We're briefly overloaded — please try again in a moment."
            : body.message || "Something went wrong. Please try again.";
        setSubmit({ kind: "error", message });
        return;
      }

      const link = body.token ? `${window.location.origin}/enroll/${slug}#pa=${body.token}` : null;
      setSubmit({ kind: "success", emailed: !!body.emailed, token: body.token ?? null, link });
    } catch {
      setSubmit({ kind: "error", message: "Network error. Please check your connection and try again." });
    }
  }

  if (state.kind === "loading") {
    return <BarePageWrapper><LoadingSkeleton /></BarePageWrapper>;
  }
  if (state.kind === "error") {
    return <BarePageWrapper><ErrorState message={state.message} slug={slug} /></BarePageWrapper>;
  }
  if (state.kind === "unavailable") {
    return <BarePageWrapper><UnavailableState slug={slug} /></BarePageWrapper>;
  }

  const tierList = joinLevels(state.coveredLevels);
  const opensAtText = formatOpensAt(state.windowOpensAt);

  return (
    <PageWrapper schoolName={state.schoolName} primaryColor={state.primaryColor} logoUrl={state.logoUrl}>
      <div className="mx-auto max-w-md">
        <h1 className="text-xl font-bold text-gray-900">Get priority access</h1>
        <p className="font-myanmar mt-1 text-base text-gray-600">ဦးစားပေးအခွင့်အရေး ရယူရန်</p>

        <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
          <p>
            <strong>{state.intakeName}</strong> — register now and you&apos;ll get an early-access link
            to enroll in <strong>{tierList}</strong> before it opens to the public.
          </p>
          <p className="font-myanmar mt-2 text-gray-600">
            <strong>{state.intakeName}</strong> ၏ <strong>{tierList}</strong> ကို အများပြည်သူ
            မဖွင့်လှစ်မီ စာရင်းသွင်းနိုင်ရန် ဦးစားပေးလင့်ခ် ရရှိမည်ဖြစ်သည်။
          </p>
          <p className="mt-3 border-t border-gray-200 pt-3">
            The head start window opens <strong>{opensAtText}</strong>.
          </p>
          <p className="font-myanmar mt-1 text-gray-600">
            ဦးစားပေးကာလသည် <strong>{opensAtText}</strong> တွင် စတင်ပါမည်။
          </p>
          <p className="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-500">
            After you sign up, the link you get won&apos;t work immediately — it activates when the
            window opens above. Clicking it beforehand just shows the event page in its normal
            &quot;not open yet&quot; state, which is expected, not an error.
          </p>
          <p className="font-myanmar mt-1 text-xs text-gray-500">
            စာရင်းသွင်းပြီးနောက် ရရှိသည့်လင့်ခ်သည် အထက်ပါအချိန်မတိုင်မီ ချက်ချင်း အလုပ်လုပ်မည် မဟုတ်ပါ။
          </p>
        </div>

        {submit.kind === "success" ? (
          <div className="mt-6">
            <SuccessPanel result={submit} primaryColor={state.primaryColor} />
          </div>
        ) : (
          <form onSubmit={(e) => handleSubmit(e, state.intakeId)} className="mt-6">
            {/* Honeypot — hidden from real users, filled by bots. Same convention
                as src/app/(public)/enroll/form/page.tsx. */}
            <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
              <label htmlFor="website_url">Website</label>
              <input
                id="website_url"
                name="website_url"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={hp}
                onChange={(e) => setHp(e.target.value)}
              />
            </div>

            <div className="mb-5">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Name<span className="ml-1 text-red-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-[#1a6b3c] focus:outline-none focus:ring-1 focus:ring-[#1a6b3c]"
                placeholder="e.g. Aung Aung"
              />
            </div>

            <div className="mb-5">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Email<span className="ml-1 text-red-500">*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-[#1a6b3c] focus:outline-none focus:ring-1 focus:ring-[#1a6b3c]"
                placeholder="example@email.com"
              />
              <p className="mt-1 text-xs text-gray-400">
                This is how we&apos;ll deliver your priority-access link.
              </p>
            </div>

            <div className="mb-5">
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-[#1a6b3c] focus:outline-none focus:ring-1 focus:ring-[#1a6b3c]"
                placeholder="09xxxxxxxxx (optional)"
              />
            </div>

            {submit.kind === "error" && (
              <div className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
                <p className="font-medium text-red-800">{submit.message}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={submit.kind === "submitting"}
              className="w-full rounded-lg py-3 text-sm font-semibold text-white transition-colors disabled:opacity-50"
              style={{ backgroundColor: state.primaryColor }}
            >
              {submit.kind === "submitting" ? (
                <span className="inline-flex items-center gap-2 justify-center">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Submitting...
                </span>
              ) : (
                <>Register Interest / <span className="font-myanmar">စိတ်ဝင်စားမှု မှတ်ပုံတင်ရန်</span></>
              )}
            </button>
          </form>
        )}

        <a href={`/enroll/${slug}`} className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-[#1a3f8a] hover:underline">
          ← Back to event page
        </a>
      </div>
    </PageWrapper>
  );
}
