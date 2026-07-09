# Handoff: Event Ticketing Flow (TechSummit example) — "Trusted Official" style

## Overview
A redesigned public-facing ticket purchase flow for EduEnroll's **event** tenant type (as opposed to language-school intakes). Covers ticket selection, attendee details, and payment — with two payment methods: **Stripe card checkout** and **PayNow (SGD QR)**. Currency is SGD throughout. Visual direction is "Trusted Official": navy + gold, structured, high-trust — matching option **3** (3a card checkout, 3b PayNow checkout) in `EduEnroll Wireframes.dc.html`.

## About the Design Files
The bundled HTML file is a **design reference** built as static, non-interactive mockups (rendered inside iPhone device frames for illustration only — the device bezel is not part of the design and should be discarded). It is not production code. The task is to **recreate these screens in the EduEnroll Next.js/React/Tailwind codebase**, replacing/extending the existing `src/components/enrollment/templates/Ev*Template.tsx` family and the enrollment form/payment pages under `src/app/(public)/enroll/`, following the existing patterns in that codebase (client components, Tailwind utility classes, the existing `TemplateProps`/`EventTemplateProps` types, `onSelect`/`onCartCheckout` handler conventions, etc.) rather than copying the mockup HTML/inline-styles directly.

## Fidelity
**High-fidelity for visual design** — exact colors, type, spacing, and card/component treatments are final and should be recreated pixel-accurately. **Low-fidelity for interaction/state** — the mockups are static frames illustrating the intended flow; hover/focus/error/loading states, real Stripe Elements/PayNow SDK wiring, and edge cases are **not** specified here and should follow the codebase's existing conventions (see the existing bank-transfer payment page at `src/app/(public)/enroll/payment/[ref]/page.tsx` for patterns like countdown timers, copy buttons, upload progress, etc. — reuse those patterns for equivalent needs here).

## Screens / Views

### 1. Ticket Selection (landing)
**Purpose:** attendee picks ticket type(s) and quantity for the event.
**Layout:** single column, mobile width (~375–420px comfortable min; should be responsive to desktop per existing `EvCorporateTemplate.tsx` grid pattern). Vertical sections: brand row → gold-rule-bordered title block → stacked ticket cards → sticky bottom cart summary bar.
- **Brand row:** 30×30px rounded-square logo mark (navy bg `#0f1f42`, gold `#d4af5a` initials, 6px radius) + org name, 12.5px/600 navy.
- **Title block:** bordered top+bottom with 1.5px solid gold (`#d4af5a`), ~16px vertical padding. Eyebrow line: 10px/700, letter-spacing 2.5px, uppercase, gold `#b7912b` — event location/dates. Headline: "Select Your Ticket", 19–20px/800, navy, tight tracking.
- **Ticket card (standard):** white bg, 1px solid `#e3e0d6` border, 10px radius, 13–14px padding, subtle shadow (`0 1px 2px rgba(15,31,66,.05)`). Row: ticket name (13px/700 navy) ↔ price (12.5px/700 navy, "SGD 180" format). Description line below (10.5px, `#8b8f9a`). Quantity stepper: bordered pill with −/qty/+ segments (26px each segment, 1px `#d8d5c9` dividers) + live subtotal text.
- **Ticket card (featured/VIP):** cream bg `#fbf8ee`, 1.5px solid gold border, small "POPULAR" pill badge (gold bg `#b7912b`, white text, 8.5px/700, 4px radius).
- **Sticky cart bar:** fixed to bottom, white bg, 1px top border `#e3e0d6`, padding ~12px/22px/18px. Row: "N tickets selected" (11.5px/700 navy) ↔ running total (12px/800 navy). Full-width CTA button below: navy fill `#0f1f42`, white text, 12px/700, 7px radius, "CONTINUE →".

### 2. Attendee Details (form step 1 of 2)
**Purpose:** collect attendee name, company, email.
**Layout:** step label row ("STEP 1 OF 2" / "Attendee details") → 2-segment progress bar (gold `#b7912b` fill / `#e9e6dc` track, 4px tall, 2px radius, 5px gap) → order summary card → "YOUR DETAILS" section → stacked form fields → CTA.
- **Order summary card:** cream bg `#fbf8ee`, 1px solid `#d4af5a` at 33% opacity, 10px radius. Line 1: qty × ticket name (bold navy) ↔ subtotal (bold navy). Line 2: event name + dates (10px, `#9a9484`).
- **Section label:** "YOUR DETAILS", 11px/700, navy, letter-spacing 1.2px, 1.5px bottom border `#eee9dc`.
- **Form fields:** label (11px/600, `#43485a`) above each input. Focused/primary field (name) gets 1.5px navy border; other fields 1.5px `#d8d5c9` border. All inputs 32–34px tall, 7px radius. Helper text under email: 9.5px, `#9a9484`.
- **CTA:** full-width navy button, white text, 12.5px/700, 8px radius, "CONTINUE TO PAYMENT →".

### 3a. Payment — Card (Stripe)
**Purpose:** pay via credit/debit card through Stripe.
**Layout:** step label/progress (both segments filled gold) → total-due card → payment method toggle → card fields → pay button → security note.
- **Total due card:** bordered `#e3e0d6`, cream-tinted bg `#fbfaf6`, 10px radius. "Total due" (11.5px, `#8b8f9a`) ↔ amount (19px/800 navy, e.g. "SGD 360.00").
- **Payment method toggle:** two equal-width segments, 7px radius, 8px vertical padding, 11px/700 text. Active segment: navy fill + white text. Inactive: 1.5px `#d8d5c9` border + `#43485a` text. Options: "CARD" / "PAYNOW".
- **Card number field:** 1.5px navy border (active state), 8px radius, placeholder-style digits at 12px letter-spaced `#9a9484`, small card-brand chips (20×13px, 2px radius) right-aligned.
- **Expiry/CVC row:** two equal fields, 1.5px `#d8d5c9` border, 34px tall, 8px radius, 11.5px `#9a9484` placeholder text.
- **Pay button:** full-width navy, white text, 12.5px/700, 8px radius, "PAY SGD 360.00".
- **Security note:** centered, 9.5px `#aca795`, lock glyph + "Secured by **stripe**" (Stripe wordmark in Stripe purple `#635bff`, 700 weight).

### 3b. Payment — PayNow
**Purpose:** pay via SGD PayNow QR (Singapore bank transfer scheme), as a Stripe-processed alternative payment method.
**Layout:** identical shell to 3a (step/progress/total-due card/method toggle) with "PAYNOW" segment active instead. Below the toggle:
- **QR card:** bordered `#e3e0d6`, 10px radius, 18px padding, centered. 130×130px QR placeholder (checkerboard pattern stand-in for real QR), caption "Scan with your banking app" (10.5px, `#8b8f9a`), sub-caption listing supported banks (9.5px, `#aca795`).
- **UEN row:** bordered `#e3e0d6`, 8px radius, row layout: "PayNow UEN" label ↔ UEN value (12px/700 navy, monospace-style tracking acceptable).
- **Waiting-for-payment chip:** amber bg `#fdf3e0`, 1px border `#eed9a3`, 8px radius, row layout: "Waiting for payment" (10.5px, `#8a6a1f`) ↔ live countdown (11.5px/800, `#8a6a1f`, mm:ss). This state should poll/subscribe for payment confirmation and auto-advance to the success screen (same pattern as the existing bank-transfer auto-cancel countdown in `payment/[ref]/page.tsx`).
- **Security note:** same as 3a.

### 4. Success / E-Ticket (one variant per payment method, same layout)
**Purpose:** confirm payment and present the e-ticket.
**Layout:** centered checkmark badge → confirmation heading → navy "ticket stub" card → payment summary card → download CTA.
- **Checkmark badge:** 42×42px circle, navy bg, gold checkmark glyph, centered above the heading.
- **Heading:** 14px/800 navy — "Payment successful" (card) or "PayNow payment received" (PayNow). Sub-line: 10.5px `#8b8f9a`, "E-tickets sent to your email".
- **Ticket stub card:** navy bg `#0f1f42`, 12px radius, 16px padding, with a right-edge perforation effect (6px wide dashed strip using a repeating vertical gradient matching the page background). Contents: eyebrow event name (9px/700, letter-spacing 1.8px, gold), ticket line ("General Admission × 2", 14px/800 white), date/venue line (10.5px, `#c9cedb`), dashed divider (`rgba(255,255,255,.25)`), then a row with order ref (label 8.5px `#8a90a5` / value 13px/800 white) and a small QR placeholder (42×42px, checkerboard pattern) right-aligned.
- **Payment summary card:** white bg, 1px `#e3e0d6` border, 9px radius. Two rows: "Amount paid" ↔ amount; "Payment method" ↔ "Visa ••4242" (card variant) or "PayNow" (PayNow variant).
- **CTA:** outlined navy button (1.5px border, navy text, transparent bg), 8px radius, 11.5px/700, "DOWNLOAD E-TICKET".

## Interactions & Behavior (to be implemented — not shown in static mockup)
- Ticket quantity steppers update running subtotal and the sticky cart bar in real time (mirror existing `EvCorporateTemplate.tsx` cart state logic).
- "Continue" buttons navigate: ticket selection → attendee details → payment → success, matching the existing 2-step form pattern in `enroll/form/page.tsx` (`StepIndicator`, step state).
- Payment method toggle switches the visible payment UI without losing entered attendee details.
- Card payment: integrate real Stripe Elements/Payment Element; on success, navigate to the success screen with real order ref and last-4.
- PayNow: integrate Stripe's PayNow payment method (or equivalent SGD QR provider) to generate a real QR + reference; poll or use a webhook-driven status endpoint to detect payment completion and auto-transition to success (reuse the polling/countdown pattern from `PaymentCountdown` in the existing payment page, but for "waiting for confirmation" rather than "time to pay").
- Errors (declined card, expired PayNow QR, network failure) should follow the existing bilingual-friendly error banner pattern used elsewhere in the app (red-bordered card with clear retry action) — English only is fine here since this flow is SGD/English-first, unlike the Myanmar language-school flow.
- Loading/processing state on the pay button while awaiting Stripe confirmation (spinner + disabled state, matching the existing spinner pattern in `enroll/form/page.tsx`'s submit button).

## State Management
- Cart state: `{ [ticketTypeId]: quantity }`, plus derived `cartCount` / `cartTotal` — same shape as `EvCorporateTemplate.tsx`'s existing cart state.
- Attendee form state: name, company, email (+ validation errors), matching the existing dynamic-field pattern in `enroll/form/page.tsx`.
- Payment method: `"card" | "paynow"` toggle state.
- Payment status: `idle | processing | awaiting_confirmation (PayNow) | succeeded | failed`.
- Order/session data needed post-payment: order ref, ticket line items, amount paid, payment method + last4 (card) — fetched from the backend after Stripe confirms payment, not held client-side pre-payment.

## Design Tokens

**Colors**
- Navy (primary/text/buttons): `#0f1f42`
- Gold (accent, eyebrows, active states): `#b7912b` (deeper) / `#d4af5a` (lighter, borders/badges)
- Page background (cream): `#f7f5ef` / card cream tint: `#fbf8ee` / `#fbfaf6`
- Card border (neutral): `#e3e0d6`
- Input border (inactive): `#d8d5c9`
- Body secondary text: `#8b8f9a`, `#9a9484`, `#aca795` (lightest)
- Field label text: `#43485a`
- Amber/warning chip: bg `#fdf3e0`, border `#eed9a3`, text `#8a6a1f`
- Stripe brand purple (wordmark only): `#635bff`
- White: `#ffffff`

**Typography**
- Font family: Inter (400/500/600/700/800). No Myanmar text needed in this flow (SGD/English-only event context) — unlike the language-school flow which pairs Inter/Noto Sans with Noto Sans Myanmar.
- Eyebrow labels: 9–10px, weight 700, letter-spacing 1.8–2.5px, uppercase.
- Headings: 14–20px, weight 800.
- Body/labels: 10.5–13px, weight 400–700 depending on emphasis.

**Spacing / Radius**
- Card radius: 9–12px. Button radius: 6–8px. Small badge/pill radius: 4–6px.
- Card padding: ~12–16px. Section vertical rhythm: 14–20px between blocks.

**Borders**
- Standard card border: 1px solid `#e3e0d6`.
- Emphasis/active border: 1.5px solid `#0f1f42` (navy) or `#d4af5a` (gold).
- Dashed dividers (ticket stub, upload dropzones elsewhere in app): 1px dashed at ~25% white opacity on navy, or `rgba(0,0,0,.1–.25)` on light backgrounds.

## Assets
No real images used — the logo mark, QR codes, and card-brand chips are all placeholder shapes (solid color blocks / repeating-gradient checkerboards) standing in for real assets. Replace with actual event branding and a real QR code generation library (e.g. `qrcode`) at implementation time.

## Files
- `EduEnroll Wireframes.dc.html` — contains the full exploration; **turn 3 (ids `3a` and `3b`)** is the approved direction described in this handoff. Open in a browser to view all screens.
- `screenshots/01-full.png` — option 3a (card checkout): ticket selection → attendee details → card payment → success.
- `screenshots/02-full.png` — option 3b (PayNow checkout): PayNow payment screen → success (shares the same ticket selection / attendee details screens as 3a).
