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
| `/enroll/[slug]/interest` | Signup form, and on success the priority-access link (a bearer credential) |

Tags also report the full page URL by default. Several URLs carry secrets or
identifiers in the query string: `ref`, `pi`, `payment_intent`, `session_id`,
`psid`, `cart_key`.

The same origin also holds two things that are not on any one page:

- **Staff sessions.** On `<tenant>.kuunyi.com` the admin dashboard and the
  public event pages share one origin. `@supabase/ssr` keeps the session in
  cookies that JavaScript can read (the browser client needs them), so a
  script on a public page can read a logged-in organiser's session, or call
  `/api/admin/*` as them. A tenant's **custom domain** does not have this
  problem: the middleware sends every staff surface to the kuunyi subdomain,
  so no staff session ever exists on the custom domain's origin.
- **Browser storage.** Checkout writes the Stripe client secret to
  `sessionStorage["cs_<ref>"]`, and the key itself is an order ref, which the
  public API accepts to show buyer details and tickets. The priority-access
  token sits in `sessionStorage["pa_<slug>"]`. Both are still there when the
  buyer goes back to the event page.

The design goal is: **organisers get ad attribution and a purchase
conversion, and no third-party script ever runs on a page that shows PII,
payment details or tickets.**

### What is guaranteed, and what is not

Stated precisely, the guarantee is:

1. **No passive collection.** On tracked pages, nothing a tag reads by
   default (page URL, referrer, DOM, storage, cookies, `dataLayer`) holds an
   order ref, personal data, payment data, a ticket, a priority token, a
   Stripe client secret or a cart idempotency key. GTM only starts in a
   document that is clean from its first evaluation (see Isolation), and
   leaving a tracked page is always a full page load.
2. **Nothing exchangeable for a ref is exposed to tracked pages.** No tracked
   page receives a ref, or a value the API would trade for one, in a
   response, a URL, storage or the DOM.
3. **Container vetting is the control against a malicious container.** The
   rules above stop a normal container from collecting what it must not. They
   do not make the origin safe against a container written to attack it:
   container code runs with the page's full privileges. That risk is managed
   by who may set a container (superadmin only) and by the platform vetting
   the organiser's container and who controls it (Open questions 3).
4. **Complete isolation needs a separate origin.** Only serving tracked pages
   from an origin that holds no buyer or staff state would isolate them
   fully. That is future work, not part of v1.

## Decisions

| Question | Decision |
|---|---|
| Who sets a tenant's GTM ID | **Superadmin only** in v1. Organisers request it; we enable it. |
| Where GTM loads | An explicit **allowlist** of browse pages. Everything else is off by default. |
| Which origin | **Production: the tenant's custom domain only.** The kuunyi subdomain shares an origin with staff sessions. Outside production GTM is **off** unless the deployment sets `GTM_ALLOW_NON_PRODUCTION=true`; staging (UAT) sets it so the tenant can verify, behind the guard. |
| Credentials already in the browser | **Fail closed**: GTM loads only if browser storage holds nothing but known-safe keys and no Supabase session cookie exists. |
| Forms and checkout | **No GTM**, including the buyer-details form. |
| Purchase conversion | Sent **server-side** after payment is confirmed (phase 2), not from the success page. |
| "Started checkout" signal | Pushed to `dataLayer` on the event page when the buyer clicks Buy, before leaving. |
| Leaving a GTM page | Always a **full page load**, so the container does not survive into a non-GTM page. |
| Order creation | **Never on a tracked page.** No tracked page may receive an enrollment ref. |
| Sensitive query params | If present, GTM is **not loaded** for that page view. |
| Events fired before GTM is ready | **Queued** in `window.dataLayer`, which GTM replays when it starts. |
| Consent banner | Out of scope for v1. Open question below. |

## Pages

### Allowlist (GTM loads)

| Route | Purpose for the organiser |
|---|---|
| `/enroll` | Event list: ad landing, page views |
| `/enroll/[slug]` | Event page: main ad landing, `view_item`, `begin_checkout` |
| `/enroll/[slug]/tickets` | Ticket selection for the Trusted Official template: `view_item`, `begin_checkout` |

That is all for v1. All three show only public event information.

`/tickets` is **not** issued tickets. The event page redirects Trusted
Official events there (`router.replace` in `src/app/(public)/enroll/[slug]/page.tsx`),
and it renders `EvTrustedOfficialTemplate`, which is the tier picker and Buy
button. Issued QR tickets are on `/checkout/success`, which stays off.

### Never

Every other route, including all of `/enroll/[slug]/checkout/**`,
`/enroll/form`, `/enroll/payment/**`, `/enroll/[slug]/success`,
`/enroll/[slug]/status`, `/enroll/[slug]/interest`,
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
  GTM-XXXX is configured for your event list and event pages. It runs only on
  your custom domain. Contact KuuNyi to change it." This makes it clear to the
  organiser what is running, and where.
- Changing the ID is logged (who, when, old → new) in the server logs, without
  any other tenant data.

Why not self-serve: an owner account compromise would otherwise let an
attacker add a script that runs on every visitor. Superadmin-only keeps that
change behind us, and v1 has one client asking. We can revisit once more
tenants want it.

## Loading the container

### Component

The public layout (`src/app/(public)/layout.tsx`) already looks up the tenant
on the server (`x-tenant-slug`, then `extractSubdomainFromHost`, which also
covers custom domains). It reads `gtm_container_id` in a **separate** small
query (so a database without the column, or a failed read, means GTM off and
leaves the tenant name, logo and org type alone) and passes it to a small
client component, `TenantTagManager`. The settings page reads it the same
way, so a missing column never resets its other fields to defaults.

`TenantTagManager` decides on the client, from `usePathname()`, whether the
current page is on the allowlist (`/enroll`, `/enroll/<slug>` where the
segment is not `form` or `payment`, or `/enroll/<slug>/tickets`). Only then,
and only when the ID is set and the isolation rules below pass, does it render the standard GTM
snippet through `next/script` (`strategy="afterInteractive"`). There is no
`<noscript>` iframe, because these pages need JavaScript anyway.

Why a pathname gate rather than a separate layout: the public layout and
`enroll/[slug]/layout.tsx` also wrap checkout, success, status and tickets,
and a route group would mean moving the two pages and their siblings' layout.
The gate keeps every file where it is. The server decides the origin rule
(below) and passes `null` instead of the ID when it fails. The container ID does reach the RSC
payload of non-tracked pages, which is harmless: the ID is public, and no
script is rendered there.

A gate only stops GTM from *starting* on the wrong page. Once started, it
stays in `window` across client navigations, which is why every exit from a
tracked page is a full page load (below).

### Isolation

GTM gets the whole origin, so the rules are about what is on the origin, not
only what is on the page. All of them must pass, every page view.

**1. Origin (server).** In production (`VERCEL_ENV === "production"`), the
layout passes the ID only when the request host is the tenant's custom domain
(`tenantForCustomHost(host)` returns this tenant). On the kuunyi subdomain it
passes `null`. Outside production (local, Vercel previews, staging) it passes
`null` unless the server env var `GTM_ALLOW_NON_PRODUCTION` is exactly
`"true"`; with it, any host is allowed, so UAT works without a custom domain
(staging staff accounts are test accounts). The default is off because those
hosts share an origin with `/admin`.

A tenant that wants GTM in production therefore needs a custom domain first.
This is the only rule that fully separates GTM from staff sessions: a cookie
check (rule 3) cannot stop an organiser logging in in another tab while the
event page is open.

**2. URL (client).** If
it has any of `psid`, `ref`, `cart_key`, `pi`, `payment_intent` or
`session_id`, GTM is not loaded for that page view. On the event page this
mainly means priority-link visits (`psid`) are not tracked. That is an
acceptable loss, and simpler and safer than rewriting the URL under Next's
router.

The fragment counts too: `#pa=…` is the emailed priority link.

**3. Browser state (client), fail closed.** GTM loads only if:

- every key in `sessionStorage` and `localStorage` matches an allowlist of
  known-safe keys. In v1 that is only `cart_<digits>` (ticket choices: class
  ids, quantities, prices, image URLs);
- no Supabase auth cookie (`sb-*`) is present in `document.cookie`;
- reading storage does not throw.

Anything else, including keys we do not know about yet, means no GTM for that
page view. So `cs_<ref>` (Stripe secret), `pa_<slug>` (priority token) and a
logged-in staff session all block it today, and a future feature that stores
a credential blocks it too, instead of leaking until someone updates a
denylist. The cost is that a buyer who comes back to the event page after
starting checkout in the same tab is not tracked again. The implementation
must check the keys that our own libraries (for example Vercel Analytics)
write, and allowlist them only if they hold nothing sensitive.

Effect order makes this work for the priority token: the event page's
capture effect (child) moves `#pa=` into `sessionStorage` before the layout's
effect (parent) runs the check.

**4. Clean from the start of the document (client).**

- The document's initial URL (its navigation timing entry) must be
  same-origin, a tracked path, and free of sensitive query or hash params.
  If it is unavailable or malformed, GTM stays off.
- Only the **first** evaluation in a document can turn GTM on (a
  per-document latch). If it is not clean, GTM stays off until a full page
  load, even if a later soft navigation looks clean. Once on, soft moves
  between tracked pages keep it; any later evaluation that is not clean stops
  rendering it for the rest of the document. A container that has started
  cannot be unloaded, which is why exits are full page loads.
- A page restored from the back/forward cache (`pageshow` with `persisted`)
  reloads, so every rule runs again on fresh state.
- Every entry into a tracked page from an untracked one is a full page load
  as well (for example "Back to tickets", the form's back action, and the
  header link).

**Residual risk.** On the subdomain outside production, where the opt-in is
set, a staff session created in another tab *after* GTM loaded is readable.
Accepted for UAT only, with test staff accounts; rule 1 removes it in
production, and the opt-in keeps it off every other non-production
deployment.

Ad parameters are **not** on this list: `fbclid`, `ttclid` and `utm_*` are
how Meta and TikTok attribute a landing to an ad, so they must reach the
pixels unchanged. Ad links should point straight at `/enroll/[slug]` with
these parameters and nothing else.

### Intended fail-closed behaviours

These look like lost tracking but are the rules working:

- **After a failed checkout POST, or after a Stripe payment, GTM stays off
  for the rest of the tab.** `ck_<cart_key>` stays after a failed POST, and
  Stripe leaves a `cs_` key; neither is on the storage allowlist.
- **A tracked page reached from an untracked one does not load GTM.**
  Untracked routes send `Referrer-Policy: strict-origin`, so the referrer is
  the bare origin, whose path `/` is not a tracked page.
- **A document that started dirty keeps GTM off** (a sensitive param, an
  untracked first page, or a dirty first evaluation), until a full page load
  of a clean tracked URL.

### Leaving a tracked page

GTM, and everything it injects, lives in `window`. A Next.js client-side
navigation (`router.push`, `<Link>`) keeps it running on the next page. So
when GTM is active, **every exit from an allowlisted page to a non-allowlisted
page must be a full page load**:

- `/enroll/[slug]` → `/enroll/form`: today `router.push` (in
  `src/app/(public)/enroll/[slug]/page.tsx`). Becomes `window.location.assign`.
- `/enroll/[slug]` → `/enroll/[slug]/interest`: already a plain `<a>`, so
  already a full load. Keep it that way.
- `/enroll/[slug]` → `/enroll/[slug]/tickets` (Trusted Official redirect):
  both tracked, so it can stay a client-side `router.replace`.
- `/enroll/[slug]/tickets` → checkout: today the template creates the order
  on `/tickets` and then `router.push`es to `/checkout/?ref=…`. See below.

### No order refs on tracked pages

An enrollment ref is a bearer key: `/api/public/enrollment/[ref]` returns the
buyer's details, payment state and issued tickets, and keeps doing so after
checkout. So **no tracked page may ever receive one, or anything that can be exchanged
for one**, whether in a response, a URL, storage or the DOM. The cart
idempotency key counts: the cart RPC returns the existing order, ref
included, for a known key in the same tenant. Hard navigation does not help if the ref arrives
while GTM is still running, since container JS can wrap `fetch` and read the
response.

The Trusted Official template breaks this today: it POSTs
`/api/public/enroll` on `/tickets` and gets `enrollment_ref` back. Order
creation therefore moves to a new untracked page,
`/enroll/[slug]/checkout/new`. `/tickets` stashes only the ticket choice and
terms acceptance (no ref, no idempotency key, no personal data) under a
`cart_<digits>` key and does a full page load there. The new page creates the
idempotency key, keeps it under `ck_<cart_key>` (not on the GTM storage
allowlist), creates the order and moves on to `/checkout/?ref=…`. A stored
key is reused only when the page is reloaded; any other arrival mints a new
one. Details in the phase 1 plan, task 4b.

The other buy flow already complies: the event page sends the buyer to
`/enroll/form`, which creates the order and is untracked. The only other API
call on a tracked page is the public intake read, which carries no refs.

To keep this from regressing, the change adds one helper (for example
`hardNavigate(url)`) and a test that fails if an allowlisted page uses
`router.push` or `next/link` towards a non-allowlisted route.

Navigating between allowlisted pages can stay client-side.

### Referrer

The global `Referrer-Policy: strict-origin-when-cross-origin` in
`next.config.mjs` limits what the next page sends to third parties to the
origin. Untracked routes (checkout, form, payment, status, success, interest)
override it with `strict-origin`, so they never hand a full same-origin URL
to the next page either. The `source` patterns are written without a trailing
slash and rely on `trailingSlash` staying unset; a test pins that.

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
| `view_item` | `/enroll/[slug]` load, or `/enroll/[slug]/tickets` load for Trusted Official | `event_slug`, `event_name`, `currency`, ticket tiers and prices |
| `begin_checkout` | Same pages, on Buy click, before the hard navigation | `event_slug`, `ticket_tier`, `quantity`, `value`, `currency` |

**Queue, do not drop.** Events are pushed onto `window.dataLayer`, creating it
if needed, even before the GTM script has run. When GTM starts, it processes
everything already in the array in order, so `view_item` fired right after the
intake loads is not lost if the container loads later. If GTM never loads
(the rules above failed), the array is only a list of public event data in
our own page, with no reader.

`begin_checkout` must be pushed before navigation. If GTM is running
(`window.google_tag_manager` exists), navigation waits for its
`eventCallback` or 300 ms, whichever is first. If it is not running, navigate
at once.

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

1. Migration (column + CHECK + trigger) on EduEnroll-dev. Staging reads the
   dev database, so there is no separate staging apply.
2. Ship the component, routes, superadmin field and settings line behind the
   column. With no IDs set there is no visible change.
3. Sky Festival sends their container ID (received 2026-10-30:
   `GTM-K7N27G9J`). We set `GTM_ALLOW_NON_PRODUCTION=true` on the staging
   deployment and the ID on staging first, they verify with GTM Preview, then
   we set it on production.

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

1. **Sky Festival's custom domain.** Production GTM needs one (Isolation,
   rule 1). Do they have a domain they can point at us, and which? Staging
   UAT does not need it.
2. **Consent.** Do Sky Festival's buyers include EU or other regions that need
   a cookie consent banner before loading tags? If yes, we need a consent
   banner and GTM Consent Mode before go-live.
3. **Who controls the container on Sky Festival's side.** Them, or an agency?
   This should be in their agreement, since that party gets script access to
   the two tracked pages.
4. ~~**Ad platforms.**~~ Answered: Meta and TikTok. Sky Festival adds the
   Meta Pixel and TikTok Pixel inside GTM themselves (2026-10-30). Still open:
   do they need a purchase event before launch, or is `InitiateCheckout`
   enough to start? This drives when phase 2 is built.
5. **Self-serve later?** If several tenants want GTM, do we move the field to
   the tenant's settings, with owner-only access and an audit log?
6. **Terms / privacy page.** Does `/privacy` need a line that organisers may
   use analytics on event pages?
7. **Vendor pixel storage keys.** The storage allowlist holds only
   `cart_<digits>`. Pixels loaded by the container (for example TikTok's)
   may write their own `localStorage` keys, which would then keep GTM off on
   the next page load. Check which keys appear after the GTM Preview pass,
   and allowlist a key only once it is confirmed to hold nothing sensitive.
   Nothing is allowlisted for this yet.
