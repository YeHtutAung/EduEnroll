# E-ticket QR on the payment page — extract the renderer, then wire it

**Status:** for review
**Type:** live defect — a paid buyer cannot get a scannable ticket
**Depends on:** nothing. Independent of the platform-fee work now on staging.

---

## The defect

A buyer pays with KBZPay, lands on `/enroll/payment/<ref>`, taps **"Download
E-Ticket / E-Ticket ကိုရယူပါ"** and gets `receipt-<ref>.pdf` — a card with the
order reference and totals, and **no QR code**. It cannot be scanned at the gate.

The button calls
[`handleDownload`](../../../src/app/(public)/enroll/payment/%5Bref%5D/page.tsx#L816),
which is an `html2canvas` screenshot of a hidden receipt `div`. There is no QR in
it and there cannot be: **that page never reads `tickets` at all.** The only
matches for "tickets" in its 2,000+ lines are a prose string and an unrelated
promo section.

Meanwhile `/enroll/[slug]/checkout/success` has the real renderer — per-ticket QR
drawn from the signed JWT, canvas PNG and jsPDF, laid out by `ticketLayout.ts`
(`qrTop`, `qrSize`, "Scan at entry").

### What is *not* the cause

The Luxury template is not involved. `EvLuxuryTemplate.tsx` is a
**ticket-selection landing page** — its `TicketCard` is a purchase card with a
qty picker and a Buy button. Grepping the e-ticket renderer for `template`,
`luxury` or `orgType` returns nothing; it is gated only on
`tickets.length > 0`. No template is "wired up" for QR, because the renderer
does not know templates exist.

### Issuance works

Real KBZPay settlements do issue tickets on the dev DB — 1, 3, 1, 3, 1 across
recent confirmed orders — and `/api/public/enrollment/<ref>` serves them. Checked
live through staging:

| Ref | Tickets | Shape |
|---|---|---|
| `LM-0902-YLPY` | 1 | `{admits, jti, jwt, tier}`, jwt 340 chars |
| `LM-0902-3SJQ` | 3 | same |

The page is handed everything it needs and discards it.

> `LM-0902-GZVB` shows 0 tickets — that is a test artefact, settled by a direct
> `UPDATE` that bypassed `settleMmqrPayment`. Not evidence of a bug.

---

## Why not the redirect

The obvious fix is to do what HitPay already does on confirmation
([page.tsx:1319](../../../src/app/(public)/enroll/payment/%5Bref%5D/page.tsx#L1319)):

```js
window.location.href = `/enroll/${encodeURIComponent(intakeSlug)}/checkout/success/?ref=${encodeURIComponent(params.ref)}`;
```

MMQR instead refreshes in place — both its success paths end on the payment page:

| Path | Today |
|---|---|
| QR modal `onSuccess` ([:2026](../../../src/app/(public)/enroll/payment/%5Bref%5D/page.tsx#L2026)) | `setShowQRModal(false); handleUploadSuccess()` |
| Page poll, modal closed ([:1263](../../../src/app/(public)/enroll/payment/%5Bref%5D/page.tsx#L1263)) | `setEnrollment(data)` |

`handleUploadSuccess` refetches `/api/public/status`, which carries no `tickets`.

**The redirect was rejected because it fixes only the live in-session moment.**
`/enroll/payment/<ref>` is linked from thirteen places, and every one of them
lands on the confirmed view later:

| Source | |
|---|---|
| Enrollment + approval emails | `enrollmentEmails.ts:42`, `verifyPayment.ts:53`, `resend-email/route.ts:110` |
| Telegram agent | `agent-auth.ts:42` |
| Status pages | `status/page.tsx:70`, `[slug]/status/page.tsx:344` |
| Admin relink | `admin/students/page.tsx:598` |
| Stripe / PayPay / HitPay returns | success + cancel URLs |

So the buyer reopening the email tomorrow, or tapping the Telegram link **at the
gate**, still gets the QR-less receipt. That is the moment the ticket is actually
needed. A redirect cannot reach it.

Secondary costs of the redirect: a full page reload immediately after money
leaves, on mobile data — a blank frame there reads as "did my payment work?" —
and the buyer ends on a URL that differs from every link the system itself sends.
It is also impossible when `intake_slug` is null.

**Decision: render in place.**

---

## How tangled the renderer is

All 1,240 lines live inside one `SuccessContent()` component, which looks
discouraging. The rendering code barely touches React:

| Piece | Lines | Closes over |
|---|---|---|
| `loadImage`, `imageDataUrl`, `roundRectPath` | 73–114 | **nothing — pure** |
| `drawCanvasSponsor` | 115–204 | **nothing — pure** |
| `renderTicketBlob` (PNG) | 205–424 | `enrollment_ref`, `event_name`, `sponsor_config` |
| ticket PDF branch in `handleDownload` | 484–755 | same three, plus `tickets`, `ticketQrUrls` |

≈**640 lines of pure rendering with a three-field data dependency.** Everything
else it needs is already module-level: `TICKET_CARD`, `TICKET_FONT`,
`TICKET_ROWS`, `fitText`, `qrTop` from `ticketLayout.ts`, and
`resolveSponsorPlacements` from `lib/sponsors`.

What genuinely belongs to the page is small: `generating` / `savingImg` / `error`
state, `receiptRef`, the `navigator.share` wrapper, and the no-ticket receipt
markup.

> The `setFillColor` / `setFont` / `setTextColor` calls inside `handleDownload`
> are **jsPDF methods, not React state**. Worth stating, because a careless grep
> reads them as state coupling and makes the extraction look impossible.

---

## Plan

### Phase 1 — extract, no behaviour change

| New file | Exports |
|---|---|
| `src/lib/tickets/render/primitives.ts` | `loadImage`, `imageDataUrl`, `roundRectPath`, `drawCanvasSponsor` |
| `src/lib/tickets/render/ticketPng.ts` | `renderTicketPng(ctx, ticket, i, n, qrUrl): Promise<Blob \| null>` |
| `src/lib/tickets/render/ticketPdf.ts` | `buildTicketPdf(ctx, tickets, qrMap): jsPDF` |

```ts
export type TicketRenderContext = {
  enrollmentRef: string;
  eventName: string;
  sponsorConfig: unknown; // raw; resolveSponsorPlacements runs inside
};
```

The success page keeps its state, refs, share/download wrappers and receipt
fallback, and calls into these. Nothing observable changes.

### Phase 2 — wire the payment page

**2a. Fetch ticket data whenever the page is confirmed — not on transition.**

An effect keyed on `[params.ref, enrollment?.status]` that runs whenever the
status *is* `confirmed`, including the very first render.

This is not a detail. The payment page's initial load calls
`/api/public/status` and does `setEnrollment(statusData)` in one step
([:1116](../../../src/app/(public)/enroll/payment/%5Bref%5D/page.tsx#L1116)), so
a buyer arriving from an email, Telegram or status link on an already-confirmed
order produces **no transition at all**. A transition-keyed fetch would have
covered only the live in-session case — the one the redirect already handled,
and the one this plan exists to move past.

`/api/public/enrollment/<ref>` returns `tickets`, `event_name` and
`sponsor_config` in a single call.

Guard it with a `cancelled` flag in the effect cleanup, so a slow response cannot
install stale tickets over a newer one — the 5s status poll makes overlapping
responses reachable.

**Not** adding `tickets` to `/api/public/status`: the payment page polls that
every 5s, and that would sign fresh ticket JWTs on every poll.

**2b. Build the QR map, and gate the buttons on it.**

The extracted renderers take a `qrUrl` / `qrMap`; something has to produce it.
Follow the pattern the success page already proves
([:813](../../../src/app/(public)/enroll/%5Bslug%5D/checkout/success/page.tsx#L813)):

- an effect keyed on the ticket list that fills
  `Record<jti, dataUrl>` via `QRCode.toDataURL(t.jwt, { width: 240, margin: 1 })`,
  with the same `cancelled` guard;
- **plus** defensive regeneration inside download/share for any `jti` missing
  from the map, because the button can be tapped before the effect settles;
- download and share **disabled, with a visible preparing state**, until every QR
  the chosen artifact needs is ready, and a clear error state if generation
  fails.

Without 2b an implementation can satisfy 2a exactly and still render a confirmed
ticket list with missing QR images.

**2c. Fallbacks unchanged.**

Render QR tickets when `tickets.length > 0`; keep today's receipt PDF when the
list is empty, so language schools (`org_type != 'event'`, which issue no
tickets) are unaffected.

No new dependencies — the payment page already imports `qrcode`, `jspdf` and
`html2canvas`.

### Phase 3 — null-slug guard (independent)

`intake_slug` is nullable — `status/route.ts:183` sets it to `null` when there is
no intake, and the HitPay redirect does `?? ""`, building
`/enroll//checkout/success/`. That 404s someone who **has already paid**. Small
and separable; can ship on its own.

---

## Out of scope, deliberately

**There are two renderers for one layout** — canvas primitives for PNG, jsPDF
primitives for PDF — because html2canvas cannot reliably rasterise a data-URI
`<img>`. This duplication is pre-existing. The extraction moves it intact.
Unifying them is a separate change with its own visual-regression risk, and
folding it in here would make a defect fix unreviewable.

---

## Verification

| Phase | How |
|---|---|
| 1 | PNG bytes identical before and after extraction. PDF compared **after normalising `/CreationDate` and `/ID`** (see below). `ticketCardGeometry.test.ts` still passes. |
| 2 | A KBZPay order end to end on the tunnel: confirmed page offers a QR e-ticket; a language-school tenant still gets the receipt. |
| 2 | Return paths — reopen the emailed link and the Telegram link on a **confirmed** order and confirm the QR is there. This is the case the redirect could not fix and the reason for the whole approach. |

### Why the PDF comparison is normalised

Raw byte-comparison of jsPDF output does not work, and this was measured rather
than assumed. Two renders of identical content one second apart:

| | Result |
|---|---|
| Raw bytes | **differ** — `/CreationDate (D:20260903150807+09'00')` |
| `setCreationDate()` pinned | **still differ** — `/ID [ <1BCD846E…> ]` is random per document |
| `/CreationDate` and `/ID` both normalised | **identical**, and still differ when content changes |

So the check is a normalised byte-compare, not a pixel diff with a tolerance: it
is exact, has no threshold to tune, and cannot pass a genuinely changed layout.
Canvas PNG output is already deterministic and needs no normalisation.

**A physical scan is required before this is called done.** Extraction should not
alter a pixel — the QR payload is the same signed JWT — but a scanner cannot be
verified by reading code, and #196 was already blocked on exactly this. One
ticket downloaded from the payment page, scanned with kuunyi-scanner.

---

## Risks

| Risk | Mitigation |
|---|---|
| Extraction silently shifts the layout | Normalised byte-compare before/after; geometry test |
| QR unreadable after the move | Physical scan gate above |
| Language-school regression | Empty-ticket branch keeps the existing receipt; covered in verification |
| Payment page bundle grows | No new deps; all three libraries already imported there |

---

## Review by Codex

### [P1] Fetch ticket data for an initially confirmed page too

Phase 2 currently says to fetch `/api/public/enrollment/<ref>` “on transition to
`confirmed`”. That does not cover the main case this plan identifies: a buyer
opening an emailed, Telegram, or status-page payment link when the first page
state is already `confirmed`. There is no transition in that render, so the QR
data is never fetched and the page remains QR-less. Specify an effect keyed by
the enrollment reference and status that fetches whenever the page is
`confirmed` (including the initial load), with an abort/cancellation guard so a
polling update cannot install stale tickets.

### [P1] Define the JWT-to-QR preparation step and its loading/error states

The extracted PNG/PDF functions require a `qrUrl` / `qrMap`, but Phase 2 only
says to fetch `tickets`; it never says where the map is produced. The payment
page must generate a data URL for each `ticket.jwt` (for example with the
existing `qrcode` import), retain the mapping by ticket id/JTI, and disable or
show a clear loading/error state for download/share until every QR needed by the
chosen artifact is ready. Otherwise an implementation can render a confirmed
ticket list with missing QR images while still satisfying the written fetch
step.

### [P2] Make extraction verification deterministic rather than byte-based

“Byte-identical” PDF output is brittle: PDF generation commonly embeds metadata
or ordering that changes even when the visual ticket is identical. Keep the
geometry test, then compare deterministic semantic inputs (ticket/JWT placement
and page count) plus rendered PNG/PDF pixels with an explicit tolerance. The
physical scanner check remains the final gate for the QR payload.

---

## Resolution of the review

| Finding | Status | Where |
|---|---|---|
| [P1] Fetch when already confirmed | **Accepted in full** | Phase 2a — effect keyed on status, fires on initial load; `cancelled` guard added |
| [P1] Define JWT-to-QR preparation | **Accepted in full** | Phase 2b — map effect, defensive regeneration, disabled/preparing/error states |
| [P2] Byte-based PDF check is brittle | **Accepted; different remedy** | Verification — normalised byte-compare instead of pixel tolerance |

On [P2] the finding is correct and was confirmed by experiment, but the suggested
remedy — rendered pixels with an explicit tolerance — was not taken. Normalising
`/CreationDate` and `/ID` restores exact equality, which is strictly stronger: no
threshold to tune, no image-diff dependency, and it cannot silently pass a
changed layout the way a loose tolerance can. If normalisation is later found to
hide a real difference, pixel comparison is the fallback.

Both [P1]s were holes in the plan, not in the code — 2a in particular would have
shipped the one path the redirect already covered while missing the email and
Telegram returns that motivate the whole approach.
