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
| How far to pivot | **Events-first.** Festivals lead; other org types stay as one "Built for every event" photo grid. |
| Features to sell | All four: QR e-tickets + scanner, local + card payments, ticket tiers & sell-out control, organiser branding. |
| Client names / logos | **Revised:** a "Trusted by top event organizers" strip with six organiser logos the owner supplied, with each organiser's permission: H-Life Entertainment, Brave Entertainment, Louder Myanmar, Thingyan Music Festival, Sky Festival, Rock In Mandalay. Still no testimonials or sales numbers. |
| Visual direction | **Revised:** white page with full-width real photos, following the pattern of Ticketmelon's organiser page. (The first "night-stage dark" build was rejected.) |
| Pricing line | **"Free to start"**: free to set up, small fee only when selling online. No number quoted. |
| Payment badges | KBZPay, CB Bank MMQR, MMQR (generic), Visa / Mastercard. |
| Photos | **Free stock (Unsplash)**, swappable for client photos later. |
| Stats band | **None.** No numbers that can be wrong. |

### Non-goals

- No pricing page, blog, or other new routes.
- No database, API, or middleware changes.
- No testimonials, case studies or sales numbers. Organiser logos only as listed in Decisions.
- No new dependencies. New images are only the 12 Unsplash photos in `public/marketing/`; the payment badges reuse files already in `/public`.
- No changes to tenant pages, `/enroll`, `/admin`, or the scanner.

## Page structure (top to bottom)

**Revised 2026-11-01.** The owner rejected the first, dark "night-stage" build.
The reference is Ticketmelon's organiser page (`organizer.ticketmelon.com`):
a white page with full-width real photos. KuuNyi follows that *pattern*
(photo hero, white sections, photo cards, industries grid) with its own
brand, copy and photos. It doesn't copy their images, text or layout.

1. **Hero (full-width photo).** `hero.jpg` (festival crowd and confetti) with
   a left-to-right dark gradient so the white text stays readable.
   - The **navbar** sits on top of the photo, transparent: logo, **Sign In**
     (`/login`), and **Get Started** (`/register`) as a white button.
   - Eyebrow "Festival & event ticketing", headline **"Sell out your
     festival."**, Myanmar subline, and the subtext.
   - CTAs: **Start selling tickets** → `/register` and **See how it works**
     → `#how`.
   - Trust line: "Free to set up — a small fee only when you sell online."
     (EN + MM).
2. **Trusted by top event organizers.** Six logo tiles in `public/marketing/organizers/`, shown as-is in uniform rounded squares because the logos come on different backgrounds. Each tile has the organiser name under it; 3 columns on phones, 6 from `sm`.
3. **Accepted payments strip (light grey).** Sits where Ticketmelon has its
   organiser-logo strip. KBZPay, CB Bank, MMQR, Visa and Mastercard logos.
4. **Solutions (white).** "Everything your festival needs", with four large
   cards in a 2×2 grid, each with a photo, label, title, Myanmar title and
   description:
   - **QR e-tickets & gate scanning** (`scan.jpg`, phone-to-phone QR):
     unique QR on the payment page and by email, scanned at the gate, each
     QR works once.
   - **Local + card payments.** No photo: a purple panel with the real
     payment logos in a 2×2 grid. Copy: KBZPay and CB MMQR for fans in
     Myanmar, Visa and Mastercard overseas, confirmed automatically.
   - **Ticket tiers & sell-out control** (`tiers.jpg`): Early Bird / GA / VIP,
     a limit per tier, and a priority window.
   - **Your event, your brand** (`brand.jpg`): your own domain, sponsor logos
     on e-tickets, and Meta / TikTok / Google pixels via Google Tag Manager.
     This is per-tenant GTM, not promoter or affiliate tracking.
   - **Cashless bars & food stalls** (wide navy card under the four, `pos.jpg`, a bartender at a tap, cropped to cut branded cups). This is the owner's separate **Event Payment System** (web + mobile app), in use at Myanmar festivals since 2017. The facts come from Idea Pro's 2017 Barrack Water Festival quotation in the owner's Drive: prepaid QR cards topped up at cash counters, a scan to pay at bars, stock and sales per counter (VVIP / VIP / GA), staff device management, and income / stock / card-balance reports. No price or contact details on the page.
5. **How it works, `#how`.** Sits where Ticketmelon has its stats band.
   `how.jpg` (purple laser lines) under an 80% navy overlay, with four big
   numbered steps: tier → pay → QR e-ticket → scan at the gate.
6. **Built for every event (light grey).** A 2-column grid (3 columns from
   `lg`) of photo tiles with EN + MM labels: Music festivals, Concerts,
   Runs & sports, Conferences & shows, Schools & training, Custom events.
   This replaces the "Also works for" pill strip, so schools still feel
   included.
7. **CTA.** A rounded photo panel (`cta.jpg`) with a purple overlay:
   **"Ready for your next festival?"**, with **Start selling tickets** and
   **Sign In**.
8. **Footer (navy).** Logo and a one-line description, then three columns:
   Product (How it works), Organisers (Get Started, Sign In), Legal
   (Privacy). © line.

**Not included:** stats band (no reliable numbers, by owner decision),
case studies and testimonials, the e-ticket
mockup, and the dark night-stage design.

## Photos

Thirteen photos in `public/marketing/`, from Unsplash under the Unsplash
License (free for commercial use, no attribution required). They were
resized at download: hero, how and cta at 2000px wide, the rest at
1000px, JPEG quality 70, about 2.6 MB in total. Each was checked by eye for
brand logos, readable text and real people's names. Rejected candidates:
a festival logo on stage, ferry tickets with passenger names, a Thai telco
app, a named conference speaker, song lyrics on screens, a Nike logo, and
an Alipay screen.

| File | Unsplash photo |
|---|---|
| `hero.jpg` (16:9 crop) | https://unsplash.com/photos/people-watching-concert-during-night-time-h81eW06xr7Y |
| `how.jpg` | https://unsplash.com/photos/white-and-black-line-illustration-r4qdM8iD5WY |
| `cta.jpg` | https://unsplash.com/photos/crowd-facing-lighted-stage-eXVd7gDPO9A |
| `scan.jpg` | https://unsplash.com/photos/two-persons-hands-holding-turned-on-phones-QiPe0UpC0_U |
| `tiers.jpg` | https://unsplash.com/photos/stage-light-front-of-audience-NYrVisodQ2M |
| `brand.jpg` | https://unsplash.com/photos/people-watching-concert-during-night-time-TVV49SQuQ_c |
| `festival.jpg` | https://unsplash.com/photos/group-of-people-in-front-of-stage-ZhQCZjr9fHo |
| `concert.jpg` | https://unsplash.com/photos/woman-in-white-and-black-plaid-shirt-holding-microphone-Ol0wJhWu3-s |
| `run.jpg` | https://unsplash.com/photos/hundreds-of-runners-participate-in-a-city-marathon-race-WivYzpzTJEQ |
| `conference.jpg` | https://unsplash.com/photos/photography-of-people-sitting-on-theater-during-nighttime-nz-UtZz81fI |
| `school.jpg` | https://unsplash.com/photos/teacher-instructing-students-in-a-classroom-lecture-u6OsIM1ZEnk |
| `pos.jpg` (top 1000×900 crop) | https://unsplash.com/photos/a-group-of-people-standing-around-a-bar-9l0VLh_C6-k |
| `custom.jpg` | https://unsplash.com/photos/person-holding-yellow-sticky-notes-MDu-53qRVr4 |

`run.jpg` shows race bibs, but their sponsor marks aren't readable at tile
size. Swap any photo for a client's own photo once they give written
permission.

## Visual design

- **Base:** a white page (`bg-white`) with slate-900 text and KuuNyi purple
  `#6d28d9` as the accent (eyebrows, primary buttons, payments panel).
  Light grey `slate-50` is used for the industries section.
- **Text on photos:** always over a dark overlay. Hero: `black/85` → `black/20`
  gradient, with the text kept on the dark left side. How it works:
  `#0f1225` at 80%. Tiles: `black/85` from the bottom. CTA: `#1e1b4b`
  at 55–95%. Text is white or `white/75`+ (≥ 4.5:1 on those overlays).
- **Navy sections** (how it works, footer) follow the earlier contrast rule:
  slate-300 for body text, no slate-500.
- **Images:** `next/image`. `fill` + `sizes` for photos and `priority` on
  the hero; explicit width/height for logos. Decorative photos have
  `alt=""`.
- **Motion:** a single `fadeUp` on the hero copy, turned off under
  `prefers-reduced-motion`. Photos zoom slightly on hover in cards and tiles.
- **Mobile:** hero CTAs stack full width, solutions go to one column, and
  industry tiles are square 2-up so the labels have room.


## SEO metadata

- Title: "KuuNyi — Festival & Event Ticketing for Myanmar"
- Description: "Sell tickets, take KBZPay, MMQR and card payments, and scan
  QR e-tickets at the gate. Built for Myanmar festivals and events."
- The same title and description go in `openGraph` and `twitter`.
  `siteName`, `locale` and `type` stay unchanged.

## Code

- **Code changes:** `src/app/page.tsx`, plus the photos in
  `public/marketing/`. The page stays a server component (no
  `"use client"`), using Tailwind and one inline `<style>` keyframe. The
  navbar sits inside the hero instead of being fixed, so it needs no
  scroll JS.
- Section content lives in typed constants at the top (`PAYMENT_LOGOS`,
  `SOLUTIONS`, `STEPS`, `INDUSTRIES`), the same pattern the old page used.
- The component is still named `LandingPage`.
- The old QR mockup (and its `Math.random()` hydration bug) is gone, along
  with the rest of the old page.
- **Tenant subdomain follow-up:** this is now YeHtutAung/EduEnroll#335.
- **Unchanged behaviour:** `src/middleware.ts` still redirects `/` to
  `/enroll` on a tenant's custom domain, so clients' own domains never show
  this page.
- **Tenant subdomains also get this page and its metadata (accepted).**
  The middleware passes `/` through on every host (`src/middleware.ts:127`),
  so `<slug>.kuunyi.com/` renders this page. The page's static `metadata`
  also overrides the tenant-aware `generateMetadata` in `src/app/layout.tsx`
  for that route, so a school's subdomain root will show the festival
  title and description in search and social previews.
  - This isn't new: today the same root shows the school-first platform
    title, not the tenant's name.
  - The pivot makes it more visible, and that is accepted for this change.
  - **Follow-up (separate PR):** redirect `/` → `/enroll` on tenant
    subdomains, the same way custom domains already work. That gives tenant
    roots tenant pages and tenant metadata.
- **Anchors:** `#mmqr` and `#features` are removed, and `#how` is added.
  `git grep` finds no reference to `#mmqr`, `#features` or `kuunyi.com/#`
  outside `src/app/page.tsx`. An external link to `kuunyi.com/#mmqr` still
  loads, just at the top of the page. No alias ids are added.

## Copy that needs review before `main`

- **Myanmar lines:** drafted in the style of the current page. They need a
  native-speaker check before promotion to `main`.
- **Product claims** must stay true to what is live:
  - "Payment is confirmed automatically" holds for KBZPay, CB MMQR and
    card. It doesn't hold for manual bank transfer, which the page won't
    mention.
  - "Visa / Mastercard": card checkout is enabled per tenant. This line
    describes a capability, not a promise for every event.

## Release gate: claims vs. what `main` has

The homepage goes live from `main`, so every capability it names has to be
live in production by then. Code presence was checked on `origin/main` and
`origin/dev` on 2026-11-01. Production database state was **not** checked
(it's off limits), and project notes say several of these migrations are
on the dev database only.

| Claim on the page | Code on `main` | Production DB | Status |
|---|---|---|---|
| QR e-tickets + gate scanner | yes | yes, per notes | OK |
| Visa / Mastercard (Stripe, HitPay) | yes | — | OK |
| Tiers, per-tier caps, priority window | yes | unverified | owner confirms |
| Custom domain | yes (`tenantForCustomHost`) | — | OK (operational gates per tenant) |
| Sponsor logos on e-tickets | yes | unverified | owner confirms |
| **KBZPay MMQR** | yes | **notes say migration not on prod** | owner confirms |
| **CB Bank MMQR** | **no**, dev only | no | **blocked** |
| **Ad pixels via GTM** | **no**, dev only | no | **blocked** |

**Rule:** this page may merge to `dev` and go to staging as designed. It may
not be promoted to `main` while any claim above is "blocked" or
unconfirmed. Before that promotion, either those features reach production
first, or the copy and badges for them are removed in the PR that promotes
to `main`.

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
