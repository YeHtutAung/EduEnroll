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
- `isTrackedPath(pathname)`: true for `/enroll` and `/enroll/<seg>` where
  `<seg>` is not `form` or `payment`; tolerates a trailing slash; false for
  everything else.
- `SENSITIVE_PARAMS = ["psid", "ref", "cart_key", "pi", "payment_intent",
  "session_id"]` and `hasSensitiveContext(location, storage)`: true if any
  sensitive param is in the query, `pa=` is in the hash, or any
  `sessionStorage` key starts with `pa_`. `storage` access is wrapped in
  try/catch; if storage throws, return true (fail closed).
- `pushDataLayer(event, payload)`: no-op when `window.dataLayer` is absent;
  pushes `{ ecommerce: null }` first, then the event (GA4 convention so
  ecommerce objects do not merge).
- `hardNavigate(url, opts?)`: `window.location.assign(url)`. With
  `opts.afterEvent`, pushes the event with `eventCallback` and navigates on
  callback or after 300 ms, whichever comes first, exactly once.

Tests: `src/__tests__/lib/tagManager.test.ts`, covering every branch above,
including `fbclid` / `ttclid` / `utm_source` **not** counting as sensitive.

### 3. `TenantTagManager` client component and wiring

`src/components/tracking/TenantTagManager.tsx` (`"use client"`):

- Props: `containerId: string | null`.
- Returns `null` unless `containerId` matches the regex, `isTrackedPath(usePathname())`
  holds, and `hasSensitiveContext(window.location, sessionStorage)` is false.
  The last check runs in an effect, so the first render is always `null` and
  hydration matches.
- Otherwise renders `<Script id="tenant-gtm" strategy="afterInteractive">` with
  the standard GTM snippet, interpolating the regex-checked ID only.

Effect order matters for the priority token: the event page's capture effect
(child) runs before the layout's effect (parent), so by the time the guard
runs the token is already in `sessionStorage` and the guard sees it.

Wiring in `src/app/(public)/layout.tsx`: add `gtm_container_id` to the
existing `tenants` select and render `<TenantTagManager containerId={…} />`
once, inside the outer `div`.

Tests: `src/__tests__/tracking/tenantTagManager.test.tsx`: renders the script
on `/enroll` and `/enroll/sky-fest-2026`; renders nothing on
`/enroll/form`, `/enroll/payment/X`, `/enroll/x/checkout`,
`/enroll/x/checkout/success`, `/enroll/x/status`, `/enroll/x/tickets`,
`/enroll/x/interest`, `/status`; nothing with a null or malformed ID; nothing
with `?psid=…`, `#pa=…` or a `pa_x` storage key; renders with `?fbclid=…`.

### 4. Event page: events and hard exits

`src/app/(public)/enroll/[slug]/page.tsx`:

- After the intake loads, `pushDataLayer("view_item", …)` once per slug with
  `event_slug`, `event_name`, `currency`, and `items` (one per ticket tier:
  `item_id` = class id, `item_name` = tier name, `price` = fee).
- `handleSelectClass` and `handleCartCheckout`: build the `begin_checkout`
  payload (`value` = sum of price × quantity, `currency`, `items`), then
  `hardNavigate(url, { afterEvent })` instead of `router.push`.

`src/components/enrollment/templates/EvTrustedOfficialTemplate.tsx`:

- Push `begin_checkout` when Buy is pressed, before the POST to
  `/api/public/enroll`. Payload from the cart, nothing else.
- Replace `router.push(\`/enroll/${slug}/checkout/?ref=…\`)` with
  `hardNavigate(...)`. GTM must not survive into checkout, which shows the
  buyer form.

Always hard-navigate, whether or not GTM is active: one code path, and the
cost is one page load at the step where the buyer is already committing.

Test: `src/__tests__/tracking/noSoftExits.test.ts`, a static check that
`src/app/(public)/enroll/[slug]/page.tsx`, `src/app/(public)/enroll/page.tsx`
and `src/components/enrollment/templates/*.tsx` contain no `router.push` /
`router.replace` to anything but `/enroll` or `/enroll/<slug>`, and no
`next/link` `href` outside the allowlist. Allowlisted patterns are listed in the
test with a comment pointing at the design.

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

`src/app/admin/settings/page.tsx` already reads the tenant row. Add
`gtm_container_id` to that read and show, only when set:

> **Google Tag Manager:** `GTM-K7N27G9J` is active on your event list and
> event pages. Contact KuuNyi to change it.

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
Preview mode:

- On `/enroll` and an event page: the container loads; `view_item` shows in
  Tag Assistant.
- Click Buy: `begin_checkout` fires, a full page load follows, and
  `window.google_tag_manager` is `undefined` on the form / checkout page.
- Open the event page with `#pa=test`: no container.

## Deploy order

1. Owner reviews this plan and the design (PR #326).
2. Feature branch `feature/tenant-gtm` from `dev`, one PR to `dev`.
3. **Migration on EduEnroll-dev** (`fnfvwzwrdsnmwxunciti`): show the diff,
   then `supabase db push` with the owner's go-ahead.
4. Merge to `dev`, then PR `dev` → `staging`; the owner applies the migration
   on staging before the code reaches it.
5. On staging, superadmin sets `GTM-K7N27G9J` on Sky Festival's tenant. Send
   them the staging event page URL; they verify in GTM Preview and set up
   their FB / TikTok pixels.
6. Sky Festival launches ads once staging checks out. Production follows the
   normal `staging` → `main` path; set the ID on production after that.

## Rollback

Clear the ID on the superadmin page: GTM stops loading on the next page view,
no deploy. The column and trigger are additive and can stay.
