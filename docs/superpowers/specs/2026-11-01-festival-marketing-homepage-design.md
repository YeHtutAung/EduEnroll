# Festival-first marketing homepage

**Date:** 2026-11-01
**Status:** Draft (design), pending owner review
**Branch:** `feature/festival-homepage` (off `origin/dev`)

## Problem

The marketing homepage at `kuunyi.com/` (`src/app/page.tsx`) still sells
KuuNyi as a school enrollment system: "Student enrolls", "Student Records",
"Enrollment Fee", a school-first industries grid, and an MMQR showcase built
around enrollment fees.

Most active clients are now **event organisers**: music festivals and
runs, such as Sky Festival and The Beats Run. A festival organiser who lands
on the homepage today sees a product for language schools.

## Goal

Rewrite the homepage so it sells KuuNyi to **music festival organisers
first**, while making clear it still works for schools and other
organisations.

### Decisions (agreed 2026-11-01)

| Question | Decision |
|---|---|
| How far to pivot | **Events-first.** Festivals lead; other org types stay as one small "Also works for" strip. |
| Features to sell | All four: QR e-tickets + scanner, local + card payments, ticket tiers & sell-out control, organiser branding. |
| Client names / logos | **None for now.** Generic proof only, until each client agrees in writing. |
| Visual direction | **Night-stage dark**: dark navy with purple stage glow and a glowing QR e-ticket mockup. |
| Pricing line | **"Free to start"**: free to set up, small fee only when selling online. No number quoted. |
| Payment badges | KBZPay, CB Bank MMQR, MMQR (generic), Visa / Mastercard. |

### Non-goals

- No pricing page, blog, or other new routes.
- No database, API, or middleware changes.
- No client names, logos, testimonials or sales numbers.
- No new images or dependencies. The mockups are CSS, and the badges reuse files already in `/public`.
- No changes to tenant pages, `/enroll`, `/admin`, or the scanner.

## Page structure (top to bottom)

1. **Navbar.** Logo, **Sign In** (`/login`), **Get Started** (`/register`).
   Same links as today, restyled as a dark glass bar so it sits on the dark
   hero.
2. **Hero (dark).**
   - Headline: **"Sell out your festival."**
   - Myanmar subline with the same meaning (festival ticketing in one place).
   - Subtext: "Tickets, payments and gate scanning — one platform for Myanmar
     music festivals."
   - Primary CTA **Start selling tickets** → `/register`; secondary
     **See how it works** → `#how`.
   - Trust line: "Free to set up — a small fee only when you sell online."
     (EN + MM).
   - Right side: glowing **QR e-ticket mockup** (event name placeholder,
     tier "VIP", quantity "×2", QR block, "Scan at gate").
3. **How it works (dark), `#how`.** Four numbered steps:
   1. Fan picks a ticket tier
   2. Pays with KBZPay, MMQR or card
   3. Gets a QR e-ticket (payment page + email)
   4. Staff scan it at the gate
4. **Features (light).** Four cards, EN title + MM title + one-line
   description:
   - **QR e-tickets + gate scanner**: every ticket has a unique QR, and staff
     scan it at entry to stop duplicates.
   - **Local + card payments**: KBZPay and CB MMQR for Myanmar fans,
     Visa / Mastercard for fans overseas. Payment is confirmed automatically.
   - **Ticket tiers & sell-out control**: Early Bird / GA / VIP, per-tier
     limits, and a priority window before public sale.
   - **Your brand**: your own domain, sponsor logos on e-tickets, and ad
     tracking for your promoters.
5. **Payments strip (light).** "Accepted payments" with four badges:
   KBZPay (`/kbzpay-logo.png`), CB Bank (`/cbmmqr/cb-bank-logo.png`),
   MMQR (`/mmqr-logo.png`), Visa + Mastercard (`/visa.svg`,
   `/mastercard.svg`).
6. **Also works for (light).** One row of small pills: Runs & sports events,
   Concerts, Language schools, Training centres, Fitness, Custom. Short line:
   "One platform — labels adapt to your organisation type."
7. **CTA banner (dark).** **"Ready for your next festival?"** (EN + MM),
   buttons **Start selling tickets** → `/register` and **Sign In** →
   `/login`.
8. **Footer.** Unchanged (logo, Privacy, © KuuNyi — Myanmar).

**Removed from today's page:** the Student Records card, the Telegram &
Messenger cards, the enrollment-fee MMQR phone mockup and steps, the
school-first Industries grid, the "Built for Myanmar" section, and the
"Free for Myanmar organizations" claim.

## Visual design

- **Dark sections** (hero, how it works, CTA): `#0f1225` (already used on the
  page), purple `#6d28d9` / `#a78bfa` glow, soft diagonal "stage light"
  beams made with blurred gradients. Text is white or slate-300/400.
- **Light sections** (features, payments, also works for): `#faf9f7`, the
  current card style. Alternating dark and light keeps the page from being
  one long dark scroll.
- **E-ticket mockup:** CSS only. A ticket shape with a notched edge, a
  purple-to-dark gradient header, and a QR block. The QR uses a **fixed
  pattern constant**, not `Math.random()`. The current page calls
  `Math.random()` during render, so the server and the browser draw
  different patterns: a hydration mismatch.
- **Motion:** keep the existing CSS keyframes (`fadeUp`, `float`, scan line).
  No JS animation libraries.
- **Mobile:** single column. The ticket mockup stacks under the hero copy.
  Buttons are full width below `sm`, as today.
- **Bilingual:** every section heading and card title has a Myanmar line,
  in the existing `font-myanmar` style.

## SEO metadata

- Title: "KuuNyi — Festival & Event Ticketing for Myanmar"
- Description: "Sell tickets, take KBZPay, MMQR and card payments, and scan
  QR e-tickets at the gate. Built for Myanmar festivals and events."
- The same title and description go in `openGraph` and `twitter`.
  `siteName`, `locale` and `type` stay unchanged.

## Code

- **One file changes:** `src/app/page.tsx`. It stays a server component
  (no `"use client"`), using Tailwind and the existing inline `<style>`
  keyframes.
- Section content lives in typed constants at the top (`STEPS`,
  `FEATURES`, `PAYMENT_METHODS`, `ALSO_FOR`), the same pattern as today's
  `FEATURES` / `INDUSTRIES` / `MMQR_STEPS`.
- The component is still named `LandingPage`.
- Images use `next/image` with explicit width and height.
- **Unchanged behaviour:** `src/middleware.ts` still redirects `/` to
  `/enroll` on a tenant's custom domain, so clients' own domains never show
  this page. Tenant subdomains (`<slug>.kuunyi.com/`) render this page today,
  and that stays as it is; it's out of scope here.

## Copy that needs review before `main`

- **Myanmar lines:** drafted in the style of the current page. They need a
  native-speaker check before promotion to `main`.
- **Product claims** must stay true to what is live:
  - "Payment is confirmed automatically" holds for KBZPay, CB MMQR and
    card. It doesn't hold for manual bank transfer, which the page won't
    mention.
  - "Visa / Mastercard": card checkout is enabled per tenant. This line
    describes a capability, not a promise for every event.

## Verification

1. `npm run build` exits 0, judged by exit code. Run it only with the dev
   server stopped (a prod build against a running dev server corrupts
   `.next`).
2. Check the page in the browser preview on the dev server:
   - desktop width and phone width (375px)
   - no console errors, and in particular no hydration warnings
   - `/register`, `/login` and `#how` links work
3. Screenshots of desktop and mobile go in the PR.
4. Open a PR to `dev`. The owner reviews it on staging before it moves on to
   `main`.

## Risks

- **Copy accuracy:** marketing claims can drift from what is live, for
  example a payment method switched off for a tenant. Mitigation: claims are
  written as capabilities, and there are no client-specific numbers or names.
- **Lost school audience:** schools that come to the homepage now see
  festivals first. Mitigation: the "Also works for" strip, plus `/register`
  and `/login` are unchanged.
