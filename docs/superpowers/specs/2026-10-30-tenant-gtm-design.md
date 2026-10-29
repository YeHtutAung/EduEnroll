# Per-tenant Google Tag Manager

**Date:** 2026-10-30
**Status:** Draft (design), pending owner review
**First client:** Sky Festival (`skyfestival`, TODO: confirm slug and add `docs/clients/skyfestival.md`)

## Problem

> **Sky Festival, 2026-10-30:** GTM is for the landing pages of their
> Facebook and TikTok media buying (paid ads). So the ad platforms are
> **Meta and TikTok**; Google Ads / GA4 are not asked for.

Organisers run paid ads on Facebook, Instagram, TikTok and Google. They want
to measure which ads bring people to their events and which lead to ticket
sales. The usual way to do this is Google Tag Manager (GTM): the site loads one
container snippet (`GTM-XXXXXXX`), and the organiser's marketing team adds
GA4, Meta Pixel, TikTok Pixel and similar tags inside GTM, with no code deploy.

KuuNyi has no tenant-level tracking today. The only analytics is Vercel
Analytics in `src/app/layout.tsx`, which is platform-wide and visible only to
us.

### Why this needs a design, not a snippet

A GTM container runs **arbitrary JavaScript chosen by whoever controls the
container**, on our origin, with full access to the page DOM, cookies that are
not `HttpOnly`, and `fetch` to our API with the buyer's session. Loading it is
equivalent to giving the organiser's marketing team, and any agency they share
the container with, script access to every page it runs on.

On our public pages that means:

| Page | What a script there could read |
|---|---|
| `/enroll/form`, `/enroll/[slug]/checkout` | Name, email, phone and custom fields as they are typed |
| `/enroll/[slug]/checkout/payment`, `/enroll/payment/[ref]` | Payment QR codes (MMQR, KBZPay), redirects to Stripe / HitPay / PayPay |
| `/enroll/[slug]/checkout/success` | Ticket QR codes and signed ticket JWTs, i.e. working tickets |
| `/enroll/[slug]/status`, `/status`, `/enroll/[slug]/success` | Buyer's name, order and payment status |
| `/enroll/[slug]/tickets` | Ticket QR codes |
| `/enroll/[slug]/interest` | Signup form, and on success the priority-access link (a bearer credential) |

Tags also report the full page URL by default. Several URLs carry secrets or
identifiers in the query string: `ref`, `pi`, `payment_intent`, `session_id`,
`psid`, `cart_key`.

The design goal is: **organisers get ad attribution and a purchase
conversion, and no third-party script ever runs on a page that shows PII,
payment details or tickets.**

## Decisions

| Question | Decision |
|---|---|
| Who sets a tenant's GTM ID | **Superadmin only** in v1. Organisers request it; we enable it. |
| Where GTM loads | An explicit **allowlist** of browse pages. Everything else is off by default. |
| Forms and checkout | **No GTM**, including the buyer-details form. |
| Purchase conversion | Sent **server-side** after payment is confirmed (phase 2), not from the success page. |
| "Started checkout" signal | Pushed to `dataLayer` on the event page when the buyer clicks Buy, before leaving. |
| Leaving a GTM page | Always a **full page load**, so the container does not survive into a non-GTM page. |
| Sensitive query params | If present, GTM is **not loaded** for that page view. |
| Consent banner | Out of scope for v1. Open question below. |

## Pages

### Allowlist (GTM loads)

| Route | Purpose for the organiser |
|---|---|
| `/enroll` | Event list: ad landing, page views |
| `/enroll/[slug]` | Event page: main ad landing, `view_item`, `begin_checkout` |

That is all for v1. Both pages show only public event information.

### Never

Every other route, including all of `/enroll/[slug]/checkout/**`,
`/enroll/form`, `/enroll/payment/**`, `/enroll/[slug]/success`,
`/enroll/[slug]/status`, `/enroll/[slug]/tickets`, `/enroll/[slug]/interest`,
`/status`, and all of `/admin`, `/superadmin`, `/login`, `/register`,
`/onboarding`.

`/enroll/[slug]/interest` could join the allowlist later if the success state
(which shows the priority link) is moved off that page. Not in v1.

## Data model

One nullable column on `tenants`:

```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS gtm_container_id TEXT
  CHECK (gtm_container_id IS NULL OR gtm_container_id ~ '^GTM-[A-Z0-9]{4,12}$');
```

- `NULL` means off. There is no separate enabled flag: clearing the ID turns
  it off.
- The CHECK constraint makes it impossible to store anything but a container
  ID, so the value can be interpolated into the snippet URL safely. The API
  validates with the same regex before writing.
- The column is read by server code only (admin client), like `logo_url` in
  `src/app/(public)/layout.tsx`. It is not secret, since it ends up in the
  page, but no public API returns it.

## Configuration

- **Superadmin**, on `/superadmin/schools/[id]`: a "Google Tag Manager" field
  with the container ID, Save and Clear. Writes go through a superadmin-only
  API route.
- **Tenant admin**: read-only line in `/admin/settings`: "Google Tag Manager:
  GTM-XXXX is active on your event list and event pages. Contact KuuNyi to
  change it." This makes it clear to the organiser what is running.
- Changing the ID is logged (who, when, old → new) in the server logs, without
  any other tenant data.

Why not self-serve: an owner account compromise would otherwise let an
attacker add a script that runs on every visitor. Superadmin-only keeps that
change behind us, and v1 has one client asking. We can revisit once more
tenants want it.

## Loading the container

### Component

A server component `TenantTagManager` reads the tenant's `gtm_container_id`
(same tenant resolution as the public layout: `x-tenant-slug`, then
`extractSubdomainFromHost`, which also covers custom domains). It renders the
standard GTM snippet through `next/script` with `strategy="afterInteractive"`
when the ID is set, and nothing otherwise. There is no `<noscript>` iframe,
because these pages need JavaScript anyway.

It is rendered by a dedicated layout that wraps only the allowlisted routes,
not by `src/app/(public)/layout.tsx` or `src/app/(public)/enroll/[slug]/layout.tsx`,
since those also wrap checkout, success, status and tickets. The likely shape
is a route group, for example `(public)/(tracked)/enroll/page.tsx` and
`(public)/(tracked)/enroll/[slug]/page.tsx`, with the URL unchanged. The
implementation plan will confirm that Next 14 resolves this without route
conflicts. If it does not, the fallback is to render the component from each
allowlisted page's server wrapper.

### Sensitive parameters

Before injecting the snippet, a small client guard checks the current URL. If
it has any of `psid`, `ref`, `cart_key`, `pi`, `payment_intent` or
`session_id`, GTM is not loaded for that page view. On the event page this
mainly means priority-link visits (`psid`) are not tracked. That is an
acceptable loss, and simpler and safer than rewriting the URL under Next's
router.

Ad parameters are **not** on this list: `fbclid`, `ttclid` and `utm_*` are
how Meta and TikTok attribute a landing to an ad, so they must reach the
pixels unchanged. Ad links should point straight at `/enroll/[slug]` with
these parameters and nothing else.

### Leaving a tracked page

GTM, and everything it injects, lives in `window`. A Next.js client-side
navigation (`router.push`, `<Link>`) keeps it running on the next page. So
when GTM is active, **every exit from an allowlisted page to a non-allowlisted
page must be a full page load**:

- `/enroll/[slug]` → `/enroll/form`: today `router.push` (in
  `src/app/(public)/enroll/[slug]/page.tsx`). Becomes `window.location.assign`.
- `/enroll/[slug]` → `/enroll/[slug]/interest`: already a plain `<a>`, so
  already a full load. Keep it that way.
- Event templates (`src/components/enrollment/templates`): only
  `EvTrustedOfficialTemplate.tsx` uses `router.push` / `next/link`. Any of its
  exits to non-allowlisted pages get the same treatment.

To keep this from regressing, the change adds one helper (for example
`hardNavigate(url)`) and a test that fails if an allowlisted page uses
`router.push` or `next/link` towards a non-allowlisted route.

Navigating between `/enroll` and `/enroll/[slug]` can stay client-side, since
both are tracked.

### Referrer

The existing `Referrer-Policy: strict-origin-when-cross-origin` in
`next.config.mjs` already limits what the next page sends to third parties to
the origin. No change.

### Content Security Policy

We send no CSP today, so nothing blocks GTM. If a CSP is added later, it must
allow `https://www.googletagmanager.com` (and whatever the container loads)
**only on the allowlisted routes**. Noted here so a future CSP does not
silently break this, or open it everywhere.

## Events for the organiser

The page pushes a small, fixed set of events to `window.dataLayer`. The
organiser's GTM setup maps them to GA4 or Meta Pixel. No personal data is
ever pushed.

| Event | Where | Fields |
|---|---|---|
| `page_view` | Automatic (GTM) | URL with no sensitive params, guaranteed by the guard above |
| `view_item` | `/enroll/[slug]` load | `event_slug`, `event_name`, `currency`, lowest ticket price |
| `begin_checkout` | `/enroll/[slug]`, on Buy click, before the hard navigation | `event_slug`, `ticket_tier`, `quantity`, `value`, `currency` |

`begin_checkout` must be pushed before navigation, and the navigation must
wait for it briefly (GTM's `eventCallback` with a short timeout, around
300 ms), so slow tag loads cannot block the buyer.

Names follow the GA4 recommended e-commerce events, so most organiser setups
work without custom mapping.

## Purchase conversion (phase 2)

The conversion organisers care about most is "ticket paid". Firing it from the
browser would need GTM on the success page, which shows working tickets. So it
is sent server-side instead, at the moment we already mark an order paid
(payment verification and webhooks: KBZPay, MMQR, HitPay, Stripe, manual
verify).

Options, in the order we expect to build them (Sky Festival buys ads on
Facebook and TikTok):

1. **Meta Conversions API**: per-tenant pixel ID and access token. Sends
   `Purchase` with `value`, `currency` and an `event_id` (an opaque hash, not
   the enrollment ref).
2. **TikTok Events API**: per-tenant pixel code and access token. Sends
   `CompletePayment` with value and currency.
3. **GA4 Measurement Protocol**: only if a tenant asks for Google.

Media buyers optimise ad delivery toward the deepest event the pixel
receives. Until phase 2, that is `InitiateCheckout` on both Meta and TikTok,
mapped in GTM from our `begin_checkout`. That is usable, but a
real purchase event optimises better. So phase 2 matters for this client and
should follow soon after phase 1.

Attribution needs a link between the ad click and the paid order. The plan is
to capture, on the tracked event page only, the non-personal click identifiers
the ad platforms set (`fbclid` / `_fbp` / `_fbc` for Meta, `ttclid` /
`_ttp` for TikTok) and carry them on the
enrollment row, so the server-side event can include them. API secrets and
tokens are stored like other per-tenant secrets, never in source or logs.

Phase 2 gets its own design. Phase 1 (this document) ships first and is useful alone: organisers get
traffic, ad landing and `begin_checkout`.

## Testing

- Unit: container ID validation (regex; rejects script, URLs, whitespace).
- Unit: the sensitive-param guard.
- Component: `TenantTagManager` renders nothing when the ID is null, and the
  snippet with the exact ID when set.
- Route test: GTM markup is present on `/enroll` and `/enroll/[slug]` for a
  tenant with an ID, and absent on checkout, form, payment, success, status,
  tickets and interest, and for a tenant without an ID.
- Static test: no `router.push` / `next/link` from allowlisted pages to
  non-allowlisted routes.
- Manual on dev / staging: a test GTM container with GTM Preview mode, checking
  that tags fire on the event page and the container is gone after clicking Buy.

## Rollout

1. Migration (column + CHECK) on EduEnroll-dev, then staging.
2. Ship the component, routes, superadmin field and settings line behind the
   column. With no IDs set there is no visible change.
3. Sky Festival sends their container ID (received 2026-10-30:
   `GTM-K7N27G9J`). We set it on staging first, they verify with GTM Preview,
   then we set it on production.

   Sky Festival starts its ads once our UAT (staging) environment has GTM
   running for them (2026-10-30). So phase 1 on staging, with their container
   ID set, is the milestone that unblocks their launch.

   They sent a ready-made snippet with it. We do not paste organiser
   snippets: we take only the ID and render our own standard GTM snippet. Theirs
   was also incomplete. It loads `gtm.js` and calls `gtag('js', …)`, but never
   pushes the `gtm.js` start event, so tags on GTM's "All Pages" (Page View)
   trigger, which is where pixel page views usually sit, would not fire.
4. Add `docs/clients/skyfestival.md` with the container ID state (the ID is
   not secret, but the file records only that it is enabled and since when).

Turning it off is clearing the field. No deploy needed.

## Open questions

1. **Consent.** Do Sky Festival's buyers include EU or other regions that need
   a cookie consent banner before loading tags? If yes, we need a consent
   banner and GTM Consent Mode before go-live.
2. **Who controls the container on Sky Festival's side.** Them, or an agency?
   This should be in their agreement, since that party gets script access to
   the two tracked pages.
3. ~~**Ad platforms.**~~ Answered: Meta and TikTok. Sky Festival adds the
   Meta Pixel and TikTok Pixel inside GTM themselves (2026-10-30). Still open:
   do they need a purchase event before launch, or is `InitiateCheckout`
   enough to start? This drives when phase 2 is built.
4. **Self-serve later?** If several tenants want GTM, do we move the field to
   the tenant's settings, with owner-only access and an audit log?
5. **Terms / privacy page.** Does `/privacy` need a line that organisers may
   use analytics on event pages?
