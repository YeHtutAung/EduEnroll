import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaimSeatView } from "@/app/(public)/t/claim/ClaimSeat";
import type { ClaimSeatState } from "@/app/(public)/t/claim/claimFlow";
import { STRIP_FRAGMENT_JS } from "@/app/(public)/t/claim/stripFragment";
import ClaimPage from "@/app/(public)/t/claim/page";

// ─── /t/claim view (plan 4, Task 12) ────────────────────────────────────────
// Effects (reading the token, the two POSTs) don't run under react-dom/server,
// so the view is rendered per state. The view is never handed the token.

const MYANMAR = /[က-႟]/;
const TOKEN = "A".repeat(20) + "b_-" + "9".repeat(20);
const noop = () => {};

const preview = { eventName: "Sky Festival", tier: "VIP", seatNo: 2, eventDate: "2026-12-20" };

const render = (state: ClaimSeatState) =>
  renderToStaticMarkup(<ClaimSeatView state={state} onClaim={noop} onRetry={noop} />);

const ALL: ClaimSeatState[] = [
  { kind: "loading" },
  { kind: "ready", preview, claiming: false },
  { kind: "ready", preview, claiming: true },
  { kind: "signIn" },
  { kind: "gone" },
  { kind: "limited", canRetry: true },
  { kind: "limited", canRetry: false },
  { kind: "error", canRetry: true },
  { kind: "error", canRetry: false },
];

describe("ClaimSeatView", () => {
  it("ready shows event, tier, seat, date and Claim this seat", () => {
    const html = render({ kind: "ready", preview, claiming: false });
    expect(html).toContain("Sky Festival");
    expect(html).toContain("VIP");
    expect(html).toContain("Ticket 2");
    expect(html).toContain("20 Dec 2026");
    expect(html).toContain("Claim this seat");
    expect(html).toContain("works only on your phone");
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
  });

  it("ready without a date still renders", () => {
    const html = render({ kind: "ready", preview: { ...preview, eventDate: null }, claiming: false });
    expect(html).toContain("Claim this seat");
  });

  it("disables the button while the claim is in flight", () => {
    expect(render({ kind: "ready", preview, claiming: true })).toMatch(/<button[^>]* disabled=""/);
  });

  it("signIn links to /account?next=%2Ft%2Fclaim", () => {
    const html = render({ kind: "signIn" });
    expect(html).toContain("Sign in to claim this seat");
    expect(html).toContain('href="/account?next=%2Ft%2Fclaim"');
    expect(html).toContain("Sign in with the email you want this seat on.");
  });

  it("gone reads naturally for a friend and for the leader opening their own link", () => {
    const html = render({ kind: "gone" });
    expect(html).toContain("This link no longer works.");
    expect(html).toContain("If you shared it, it&#x27;s still your seat.");
  });

  it("limited says to try later", () => {
    expect(render({ kind: "limited", canRetry: true })).toContain("Too many tries. Try again later.");
  });

  it("offers Try again only while the token is still held", () => {
    expect(render({ kind: "error", canRetry: true })).toContain("Try again");
    expect(render({ kind: "error", canRetry: false })).not.toContain("<button");
    expect(render({ kind: "error", canRetry: false })).toContain("Open the link again");
  });

  it.each(ALL)("every state is bilingual and never renders the token (%j)", (state) => {
    const html = render(state);
    expect(html).toMatch(MYANMAR);
    expect(html).not.toContain(TOKEN);
  });
});

describe("/t/claim page", () => {
  it("renders the strip script as its first element, then the claim view", () => {
    const html = renderToStaticMarkup(<ClaimPage />);
    expect(html.startsWith(`<script>${STRIP_FRAGMENT_JS}</script>`)).toBe(true);
    expect(html).toContain("Loading");
    expect(html).not.toContain(TOKEN);
  });
});
