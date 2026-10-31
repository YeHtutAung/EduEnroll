# Per-tenant GTM, phase 1: implementation plan

**Status:** for review
**Design:** [2026-10-30-tenant-gtm-design.md](../specs/2026-10-30-tenant-gtm-design.md)
**Unblocks:** Sky Festival's Facebook / TikTok ads, which start once GTM runs
for them on UAT (staging)

---

## Scope

In: the `gtm_container_id` column and its guard, loading GTM on `/enroll` and
`/enroll/<slug>`, the sensitive-context guard, hard navigation out of the
event page, `view_item` and `begin_checkout`, the superadmin field, the
read-only settings line, tests.

Out: server-side purchase events (phase 2), consent banner, tenant
self-serve.

## Found while planning

Two things the design did not know, both now in the design doc:

1. **Owners write `tenants` straight from the browser.** `/admin/settings`
   updates the row through the Supabase client, and the RLS policy
   `tenants_update` (`015_staff_policies.sql`) lets an owner update **any
   column** of their own row. "Superadmin only" therefore needs a database
   guard, not just a superadmin-only API. Task 1 adds a trigger.
2. **Priority tokens live in `sessionStorage`** (`pa_<slug>`, see
   `src/lib/interest/priorityUnlock.ts`), readable by any script on the page.
   The guard (task 3) skips GTM when one is present.

### Codex review of `d5d51c3` (3 findings, all confirmed in code)

| # | Finding | Change |
|---|---|---|
| P1 | `sessionStorage["cs_<ref>"]` (Stripe secret + order ref) and staff sessions on the same origin pass a URL-and-`pa_*` guard | Origin rule (production: custom domain only) and a **fail-closed** storage / cookie allowlist. Tasks 2, 3. |
| P2 | Trusted Official renders on `/enroll/<slug>/tickets`, which was excluded, so its `begin_checkout` had no consumer | `/tickets` is ticket selection, not issued tickets: added to the allowlist. Tasks 2, 4. |
| P2 | `view_item` could fire before GTM exists and be dropped | `pushDataLayer` always queues onto `window.dataLayer`; GTM replays it. Task 2. |

### Codex re-review of `934bc61` (1 finding, confirmed)

| # | Finding | Change |
|---|---|---|
| P1 | Trusted Official POSTs `/api/public/enroll` from the tracked `/tickets` page, so container JS can read `enrollment_ref` from the response. The ref opens `/api/public/enrollment/[ref]` (buyer details, payment, tickets), even after checkout. | Order creation moves to a new untracked page, `/enroll/<slug>/checkout/new`, reached by a full page load. Task 4b. |

### Codex re-review of `54c2074` (1 finding, confirmed)

| # | Finding | Change |
|---|---|---|
| P1 | The handoff stash written on `/tickets` held the `idempotency_key`. `submit_cart_enrollment` returns the existing order for a known key and tenant, so container JS could replay the POST after checkout and get `enrollment_ref` back. | The key is created and kept only on `/checkout/new`, in storage the GTM allowlist rejects. `/tickets` passes ticket choices and terms acceptance only. Task 4b. |

Checked at the same time: the only other API call on any tracked page is
`GET /api/public/enroll/<slug>` (public intake data, no refs). The other buy
flow already creates its order on `/enroll/form`, which is untracked.

## Tasks

### 1. Migration: column, format check, change guard

`supabase/migrations/20261030120000_tenant_gtm_container.sql`, in the style of
`20261023120000_intake_custom_font.sql` (header comment, additive, deploy
order note):

```sql
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS gtm_container_id TEXT;

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_gtm_container_id_format
  CHECK (gtm_container_id IS NULL OR gtm_container_id ~ '^GTM-[A-Z0-9]{4,12}$');

-- Only the platform may change it. Owners can UPDATE their own tenants row
-- through RLS (tenants_update), so a policy alone cannot protect one column.
CREATE OR REPLACE FUNCTION public.guard_tenant_gtm_container()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.gtm_container_id IS DISTINCT FROM OLD.gtm_container_id
     AND coalesce(auth.role(), '') <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'gtm_container_id can only be changed by the platform'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_guard_gtm ON public.tenants;
CREATE TRIGGER trg_tenants_guard_gtm
  BEFORE UPDATE OF gtm_container_id ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_gtm_container();
```

The superadmin API writes through `createAdminClient()` (service role), so it
passes. An owner's browser update of that column fails with 42501. Updates
that do not touch the column (logo, messenger) are unaffected, because the
trigger is `UPDATE OF gtm_container_id`.

Add `gtm_container_id: string | null` to `Tenant` in `src/types/database.ts`.

Test: `src/__tests__/migrations/tenantGtmContainer.test.ts`, following the
existing migration tests, asserting the column, the CHECK regex and the
trigger exist in the SQL.

### 2. `src/lib/tagManager.ts`: pure helpers

Like `src/lib/eventFont.ts`, one module holds the rules, used by the API, the
component and the tests:

- `GTM_CONTAINER_ID_RE = /^GTM-[A-Z0-9]{4,12}$/` and
  `normalizeGtmContainerId(input: unknown): string | null | "invalid"`
  (trims, uppercases, `""` → `null`).
- `isTrackedPath(pathname)`: true for `/enroll`, `/enroll/<seg>` where
  `<seg>` is not `form` or `payment`, and `/enroll/<seg>/tickets`; tolerates
  a trailing slash; false for everything else.
- `gtmAllowedOnHost({ host, tenantSlug, isProduction, allowNonProduction })`:
  in production, true only when `tenantForCustomHost(host) === tenantSlug`;
  otherwise true only with `allowNonProduction` (the layout passes
  `process.env.GTM_ALLOW_NON_PRODUCTION === "true"`). Off by default.
- `SENSITIVE_PARAMS = ["psid", "ref", "cart_key", "pi", "payment_intent",
  "session_id"]`.
- `SAFE_STORAGE_KEYS = [/^cart_\d+$/]` (plus any key our own libraries write
  that the implementation confirms is harmless, each with a comment).
- `isBrowserStateClean({ location, sessionStorage, localStorage, cookie })`:
  false if any sensitive param is in the query, `pa=` is in the hash, any key
  in either storage fails `SAFE_STORAGE_KEYS`, or `cookie` has a name
  starting with `sb-`. Any thrown error returns false. This is an
  **allowlist**: unknown keys block GTM. It also takes `initialUrl` (the
  document's navigation entry name): it must be same-origin, a tracked path,
  with no sensitive query or hash param; missing or malformed fails closed.
- `decideGtmForDocument(clean)`: per-document latch. Only the first
  evaluation can turn GTM on; any evaluation that is not clean turns it off
  for the rest of the document.
- `reloadIfRestoredFromCache(event)`: `pageshow` handler that reloads on a
  back/forward cache restore. `claimNavigation(ref)`: one checkout
  navigation per click.
- `pushDataLayer(event, payload)`: `window.dataLayer = window.dataLayer || []`,
  then pushes `{ ecommerce: null }` and the event (GA4 convention so
  ecommerce objects do not merge). Never a no-op, so events fired before GTM
  starts are queued and replayed.
- `hardNavigate(url, opts?)`: `window.location.assign(url)`. With
  `opts.afterEvent`, pushes the event; if `window.google_tag_manager` exists,
  navigates on `eventCallback` or after 300 ms, whichever comes first,
  exactly once; otherwise navigates at once.

Tests: `src/__tests__/lib/tagManager.test.ts`, covering every branch above,
including `fbclid` / `ttclid` / `utm_source` **not** counting as sensitive,
`cs_ABC` / `pa_x` / an unknown key / an `sb-…-auth-token` cookie each
blocking, `cart_123` alone passing, a throwing storage blocking, events pushed
before `dataLayer` exists being kept, and `gtmAllowedOnHost` for custom
domain vs subdomain in and out of production.

### 3. `TenantTagManager` client component and wiring

`src/components/tracking/TenantTagManager.tsx` (`"use client"`):

- Props: `containerId: string | null`.
- Returns `null` unless `containerId` matches the regex, `isTrackedPath(usePathname())`
  holds, and `isBrowserStateClean(...)` is true.
  The last check runs in an effect, so the first render is always `null` and
  hydration matches.
- Otherwise renders `<Script id="tenant-gtm" strategy="afterInteractive">` with
  the standard GTM snippet, interpolating the regex-checked ID only.

Priority token and effect order: `TenantTagManager` and the page content are
siblings under the public layout, and `TenantTagManager` comes first, so the
guard's effect runs **before** the event page's capture effect. On that first
evaluation `#pa=` is still in the hash, and the guard blocks on it (and the
initial-URL check blocks on it too). After the capture effect has moved the
token into `pa_<slug>`, any later evaluation blocks on that storage key. GTM
is blocked either way; the guard does not rely on which effect runs first.

Wiring in `src/app/(public)/layout.tsx`: read `gtm_container_id` in its own
query, separate from the main `tenants` select (an error means GTM off, and
the header keeps the tenant name, logo and org type), apply
`gtmAllowedOnHost` with the request host,
`process.env.VERCEL_ENV === "production"` and the opt-in, and render
`<TenantTagManager containerId={allowed ? id : null} />` once, inside the
outer `div`.

Tests: `src/__tests__/tracking/tenantTagManager.test.tsx`: renders the script
on `/enroll`, `/enroll/sky-fest-2026` and `/enroll/sky-fest-2026/tickets`;
renders nothing on `/enroll/form`, `/enroll/payment/X`, `/enroll/x/checkout`,
`/enroll/x/checkout/success`, `/enroll/x/status`, `/enroll/x/interest`,
`/status`; nothing with a null or malformed ID; nothing with `?psid=…`,
`#pa=…`, a `pa_x` or `cs_x` storage key, or an `sb-` cookie; renders with
`?fbclid=…`.

### 4. Event page: events and hard exits

`src/app/(public)/enroll/[slug]/page.tsx`:

- After the intake loads, `pushDataLayer("view_item", …)` once per slug with
  `event_slug`, `event_name`, `currency`, and `items` (one per ticket tier:
  `item_id` = class id, `item_name` = tier name, `price` = fee).
- `handleSelectClass` and `handleCartCheckout`: build the `begin_checkout`
  payload (`value` = sum of price × quantity, `currency`, `items`), then
  `hardNavigate(url, { afterEvent })` instead of `router.push`.

`src/app/(public)/enroll/[slug]/tickets/page.tsx` (Trusted Official):

- After the intake loads, `pushDataLayer("view_item", …)` with the same shape
  as the event page. The event page does not fire `view_item` when it
  redirects here, so it is counted once.

`src/components/enrollment/templates/EvTrustedOfficialTemplate.tsx`: see
task 4b. The template no longer creates the order.

Always hard-navigate, whether or not GTM is active: one code path, and the
cost is one page load at the step where the buyer is already committing.

Test: `src/__tests__/tracking/noSoftExits.test.ts`, a static check that
`src/app/(public)/enroll/[slug]/page.tsx`, `src/app/(public)/enroll/page.tsx`,
`src/app/(public)/enroll/[slug]/tickets/page.tsx` and
`src/components/enrollment/templates/*.tsx` contain no `router.push` /
`router.replace` to anything but allowlisted paths, and no
`next/link` `href` outside the allowlist. Allowlisted patterns are listed in the
test with a comment pointing at the design.

### 4b. Trusted Official: create the order off the tracked page

Rule: **no tracked page may receive an enrollment ref, or anything that can
be exchanged for one**, in a response, a URL, storage or the DOM. The cart
idempotency key is such a thing: `submit_cart_enrollment` returns the
existing order, ref included, for a known key in the same tenant
(`20261022130000_cart_idempotency.sql`). Today `handleCheckout` in
`EvTrustedOfficialTemplate.tsx` POSTs `/api/public/enroll` on `/tickets` and
gets `enrollment_ref` back while GTM is running.

New flow:

1. **`/tickets` (tracked), Buy pressed.** Validate as today (cart not empty,
   terms ticked). Write one stash to `sessionStorage` under
   `cart_<Date.now()>` (the key shape the storage allowlist already accepts):
   `{ slug, items: [{ class_id, quantity }], terms_accepted, terms_version,
   organiser_terms_sha256 }`. No ref, no idempotency key, no personal data, no
   priority token. Push `begin_checkout`, then
   `hardNavigate(\`/enroll/${slug}/checkout/new?cart_key=${key}\`)`.
2. **`/enroll/<slug>/checkout/new` (untracked, new page).** On mount, read
   and validate the stash (slug matches, items non-empty). If the current
   navigation is a reload of this page
   (`performance.getEntriesByType("navigation")[0]?.type === "reload"`), reuse
   the idempotency key from `sessionStorage["ck_<cart_key>"]`. In every other
   case (including an unknown type), create one with `randomId()` and
   overwrite `ck_<cart_key>`. Either way it is written **before** the POST. `ck_` is not on the
   GTM storage allowlist, so while it exists no tracked page in this tab loads
   GTM. Read the priority token from `pa_<slug>` here, not on `/tickets`.
   POST `/api/public/enroll` with the body the template sends today. On
   success, delete the stash and `ck_<cart_key>`, and `router.replace(\`/enroll/${slug}/checkout/?ref=…\`)`; both pages
   are untracked, so a client-side move is fine. On error, show it with a
   "Back to tickets" plain `<a>` to `/enroll/<slug>/tickets/`. Missing or
   invalid stash (back button, reload after success): `window.location.replace`
   to `/enroll/<slug>/tickets/` (a full load: `/tickets` is tracked).
3. A reload during step 2 finds `ck_<cart_key>` and re-sends the same key, so
   the server returns the same order instead of creating a second one. If
   the POST failed, `ck_` stays (the order may exist with a lost response),
   which keeps GTM off `/tickets` in that tab. That is the intended fail-closed
   cost.

Terms: the buyer still ticks the box on `/tickets`; the POST that records
acceptance follows one page load later in the same tab, with the same
`terms_version` and `organiser_terms_sha256`. What the server records does
not change.

The page sits under `checkout/**`, so it is untracked by the allowlist with no
extra rule, and it reuses the checkout page's shell and loading state.

Tests:

- `src/__tests__/enrollment/trustedOfficialCheckoutNew.test.tsx`: POSTs the
  stashed body once, includes the priority token when present, replaces to
  `/checkout/?ref=…`, deletes the stash and `ck_`; creates the key on this
  page and reuses it from `ck_` on reload; never reads a key from the stash;
  redirects to `/tickets/` on missing,
  malformed or other-slug stash; shows the error and back link on a failed
  POST.
- `src/__tests__/tracking/noRefOnTrackedPages.test.ts`: a static check that
  the tracked pages and `src/components/enrollment/templates/*.tsx` contain no
  `fetch` to `/api/public/enroll` with a POST, no read of `enrollment_ref`,
  and no `idempotency_key` or `randomId` use. Fails if order creation or its
  key ever moves back.
- In `tagManager.test.ts`: a `ck_x` storage key blocks GTM.

### 5. Superadmin: set and clear

API: `src/app/api/superadmin/schools/[id]/gtm/route.ts`, `PUT` with
`{ gtm_container_id: string | null }`:

- Same `requireSuperadmin()` check as the sibling `schools/[id]/route.ts`
  (extract it to a shared helper if copying would be a third copy).
- `normalizeGtmContainerId`; `"invalid"` → 400.
- Update via `createAdminClient()`. Log `[gtm] tenant=<id> changed by
  superadmin=<user id>: <old> -> <new>`. Container IDs are public, so they are
  fine to log; nothing else about the tenant is.

UI: on `src/app/superadmin/schools/[id]/page.tsx`, a "Google Tag Manager"
card with the current ID, a text input, Save and Clear, and a one-line note:
"Loads on the tenant's event list and event pages only."

Tests: `src/__tests__/api/superadmin/tenantGtm.test.ts`: 401 / 403 for
non-superadmins, 400 for malformed IDs, 200 sets and clears.

### 6. Tenant settings: read-only line

`src/app/admin/settings/page.tsx` already reads the tenant row. Read
`gtm_container_id` in a separate query (an error hides the line and leaves
every other loaded setting alone) and show, only when set:

> **Google Tag Manager:** `GTM-K7N27G9J` is configured for your event list
> and event pages. It runs only on your custom domain. Contact KuuNyi to
> change it.

No input. The trigger from task 1 rejects a write anyway.

### 7. Checks before PR

```bash
npx tsc --noEmit
```

```bash
npx vitest run
```

```bash
npx next lint
```

```bash
npm run build
```

Then a manual pass on a local dev tenant with a test container in GTM
Preview mode. Locally, GTM is off unless `.env.local` sets
`GTM_ALLOW_NON_PRODUCTION=true` (then restart the dev server):

- On `/enroll` and an event page: the container loads; `view_item` shows in
  Tag Assistant.
- Click Buy: `begin_checkout` fires, a full page load follows, and
  `window.google_tag_manager` is `undefined` on the form / checkout page.
- Open the event page with `#pa=test`: no container.
- Set `sessionStorage.cs_TEST = "x"`, reload the event page: no container.
- Log in to `/admin` in the same browser, open the event page: no container.
- A Trusted Official event: `view_item` on `/tickets`, `begin_checkout` on
  Buy, then a full load into `/checkout/new`, which creates the order and
  moves to `/checkout/?ref=…`. In DevTools Network on `/tickets`, no request
  returns an `enrollment_ref`.
- From checkout, press Back to `/tickets`: the page reloads (no back/forward
  cache restore) and no container loads.
- A Messenger entry with `?psid=` on a Trusted Official event: no container,
  including after the redirect to `/tickets`.
- After the pixels have fired, do a second hard page load of the event page
  and list the `localStorage` / `sessionStorage` keys. Any vendor key keeps
  GTM off; record it for the allowlist review (design, Open questions 7).
- A failed POST on `/checkout/new`, then "Back to tickets": no container
  (`ck_` stays, by design).
- `curl -I` on `/enroll/x/checkout/new` and `/enroll/form`: both send
  `Referrer-Policy: strict-origin`.
- On the dev database, the three trigger checks:
  1. an owner PATCH of `gtm_container_id` gets 42501;
  2. an owner PATCH of another column succeeds;
  3. a service-role PATCH of `gtm_container_id` succeeds.

### Intended fail-closed behaviours

Not bugs; the manual pass should see these:

- GTM stays off for the rest of the tab after a failed checkout POST
  (`ck_` stays) or after a Stripe payment (`cs_` key).
- GTM stays off on a tracked page reached from an untracked one: untracked
  routes send `strict-origin`, so the referrer has path `/`.
- GTM stays off when the document started dirty, until a full load of a clean
  tracked URL.

### Guarantee (threat model)

- No passive collection of refs or PII on tracked pages.
- Nothing exchangeable for a ref is exposed to tracked pages.
- Against an actively malicious container, the control is the platform
  vetting the container (superadmin-only setting, agreement with whoever
  controls it).
- Only a separate origin for tracked pages would isolate them completely;
  that is future work.

Open item: vendor pixel storage keys (for example TikTok's) may need
allowlisting after the Preview pass. Nothing is allowlisted now.

## Deploy order

1. Owner reviews this plan and the design (PR #326).
2. Feature branch `feature/tenant-gtm` from `dev`, one PR to `dev`.
3. **Migration on EduEnroll-dev** (`fnfvwzwrdsnmwxunciti`): show the diff,
   then `supabase db push` with the owner's go-ahead.
4. Merge to `dev`, then PR `dev` → `staging`. Staging reads the **dev**
   database, so the migration from step 3 already covers it: there is no
   separate staging apply.
5. In Vercel, add `GTM_ALLOW_NON_PRODUCTION=true` to the **Preview**
   environment **scoped to the `staging` branch only** (not to all Preview
   branches, which would turn it on for every preview deployment). It is
   server-only; without it GTM stays off outside production. Redeploy
   staging.
   Then superadmin sets `GTM-K7N27G9J` on Sky Festival's tenant. Send them the
   staging event page URL; they verify in GTM Preview and set up their FB /
   TikTok pixels.
6. Sky Festival launches ads once staging checks out. Production follows the
   normal `staging` → `main` path. **In production GTM loads only on the
   tenant's custom domain**, so Sky Festival needs one mapped in
   `TENANT_CUSTOM_DOMAINS` before the ID does anything there. Ads must link
   to the custom domain.

## Rollback

Clear the ID on the superadmin page: GTM stops loading on the next page view,
no deploy. The column and trigger are additive and can stay.
