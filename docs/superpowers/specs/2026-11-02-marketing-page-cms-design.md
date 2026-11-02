# Marketing page content management

**Date:** 2026-11-02
**Status:** Draft (design), revised after Codex review, pending owner review
**Branch:** `feature/marketing-page-cms` (off `origin/dev`)

## Problem

Everything on the marketing homepage (`src/app/page.tsx`, from #334) is
hardcoded: wording, partner logos, photos and payment badges. Any change needs a
developer, a PR and a trip through dev → staging → main. The owner wants to
manage this content without a code change.

## Goal

A **Marketing** section in the superadmin portal where the owner can edit the
homepage's content, preview it, and publish it.

### Decisions (agreed 2026-11-02)

| Question | Decision |
|---|---|
| First-version scope | Everything: texts, partner logos, images, accepted payments, section show/hide, SEO. |
| When changes go live | Draft → preview → publish, with restore of earlier published versions. |
| Who can edit | Superadmins only. |
| Storage model | One versioned JSON content record (see Approach). |

### Non-goals

- Layout, colours, section order and button links stay in code.
- No scheduled publishing, extra languages, page analytics, or per-tenant pages.
- No external CMS and no new npm dependencies.
- No change to tenant pages, `/enroll`, `/admin` or payment code.

## Approach

| Option | Verdict |
|---|---|
| **A. One versioned content record** | **Chosen.** Draft, publish and restore are each a change of version. |
| B. A table per item type | Publishing several tables atomically and restoring old versions gets complicated, and one page doesn't need it. |
| C. External CMS | Adds a vendor, a login and a cost for one page. |

## Admin UI: `/superadmin/marketing`

Under the existing superadmin layout, which already redirects anyone whose
`users.role` is not `superadmin`. A link is added to the superadmin overview.

| Tab | Controls |
|---|---|
| **Texts** | Each section's wording, English and Myanmar side by side. |
| **Partner logos** | Upload, rename, reorder, hide, remove. |
| **Images** | Replace the hero, solution-card, how-it-works, industry and CTA photos. |
| **Accepted payments** | Add, remove, reorder, hide logos. |
| **Sections & SEO** | Show or hide whole sections; page title and description. |

Header actions: **Save draft**, **Preview**, **Publish**, **Restore a previous
version**.

- Reordering uses up/down buttons (no drag-and-drop dependency).
- **Preview** opens `/superadmin/marketing/preview` in a new tab, not an iframe:
  `next.config.mjs` sends `X-Frame-Options: DENY` on every path. The preview page
  is behind the superadmin layout, shows a "Draft preview" banner, and is
  `noindex`.
- **Hiding a payment doesn't change the wording.** Copy such as "Pays with
  KBZPay, MMQR or card" is separate text, so the Accepted payments tab shows a
  reminder to check the wording when a method is hidden.

## Content model

`MarketingContent` is a TypeScript type in `src/lib/marketing/content.ts`:

- `schemaVersion: number`
- `seo`: `title`, `description`
- `sections`: one boolean per section (`organizers`, `payments`, `solutions`,
  `pos`, `howItWorks`, `industries`, `cta`). The hero and footer can't be hidden.
- `hero`: image, nav and button labels, eyebrow, headline `{ en, mm }`, subtext,
  trust line `{ en, mm }`. The eyebrow and subtext are English only, as on today's
  page (amended 2026-11-02, plan Decision 11; approved by the owner 2026-11-02).
- `organizers`: heading text, then a list of `{ id, name, image, hidden }`
- `payments`: heading text, then a list of `{ id, name, images[], hidden }`
- `solutions`, `pos`, `howItWorks`, `industries`, `cta`, `footer`: text and
  images. Item counts for these are fixed in this version; items can be hidden
  but not added.

Text fields are strings, with `{ en, mm }` wherever the page shows both.

An **image reference** is `{ kind: "static", path }` for a file under `public/`,
or `{ kind: "bucket", path }` for an object in the `marketing-assets` bucket.
Never a free-form URL. Each also stores `width` and `height` for `next/image`.

`src/lib/marketing/defaultContent.ts` holds today's page as a
`MarketingContent` constant. The existing Unsplash and organiser files stay in
`public/marketing/`.

## Validation

`validateMarketingContent(unknown)` in `src/lib/marketing/validate.ts` is
hand-written, because the repo has no schema library and this adds no
dependency. It:

- rejects unknown keys and wrong types;
- enforces length limits per field and a cap on list lengths (for example, 24
  logos);
- accepts static paths only under `/marketing/` or the known payment logo files,
  with no `..`;
- accepts bucket paths only in the shape the upload route generates.

It runs on every draft save and again at publish. The public page also validates
what it reads, so a bad row falls back to defaults.

Content is rendered as plain React text. No `dangerouslySetInnerHTML`, no
Markdown and no editable links, so an edit can't inject HTML or a `javascript:`
URL.

## Data

New migration, `marketing_page_versions`:

| Column | Notes |
|---|---|
| `id uuid` PK | |
| `status text` | `draft`, `published` or `archived` (check constraint) |
| `content jsonb` | Validated in application code |
| `revision integer` | Incremented on each save, for the concurrent-edit check |
| `created_by`, `published_by` | `uuid` references to `users`, nullable |
| `created_at`, `updated_at`, `published_at` | `timestamptz` |

- Partial unique indexes allow at most one `draft` and one `published` row.
- RLS is on with **no policies**. RLS alone doesn't remove grants, and hosted
  Supabase gives new tables full DML to `anon` and `authenticated` by default,
  so the migration explicitly **revokes all table privileges from `anon` and
  `authenticated`** and grants `service_role` only what it needs. All access is
  server-side with the service role, after `requireSuperadmin` for admin paths.
  The public page reads only the published row, server-side.
- `publish_marketing_draft(p_expected_revision, p_user_id)` is a single database
  function that runs in one transaction: lock the draft with `FOR UPDATE`, check
  its revision, archive the current published row, promote the draft. It raises
  on a revision mismatch or a missing draft. It sets an explicit `search_path`.
- `create_marketing_draft` is described under Draft lifecycle. It and the publish
  function both take the same `pg_advisory_xact_lock` first. Otherwise a save could
  read the old published id, wait on the unique index while a publish commits, and
  then insert stale content.
- For both functions, the migration revokes execute from `PUBLIC`, `anon` and
  `authenticated` and grants it to `service_role` only.

### Draft lifecycle and concurrency

Every write to a draft is conditional on the revision the editor loaded, so two
editors can't silently overwrite each other.

- **`GET` never writes.** With no draft row, it returns the published content (or
  `defaultContent`) as a starting draft with `revision: 0` and `basePublishedId`,
  the id of the published row it started from (`null` if none). No content is
  seeded by the migration.
- **First save** (`revision: 0`) sends `basePublishedId` and calls
  `create_marketing_draft(p_base_published_id, p_content, p_user_id)`. It inserts
  the draft only if no draft exists **and** the current published id still matches
  the base; otherwise the route returns 409. Without the base check, an editor who
  opened the page before someone else published could recreate a draft from stale
  content and later publish over the newer version.
- **Later saves** run `UPDATE … WHERE status = 'draft' AND revision = $expected`,
  setting `revision = revision + 1`. Zero rows updated means 409.
- **Restore** takes the expected revision too, and `basePublishedId` when there's
  no draft yet, and follows the same rules as a save. It copies an archived version's content into the draft after validating it (an
  invalid old version returns 422), so it goes through preview and publish like
  any other edit. It never publishes directly.
- **Publish** takes the expected revision. The route reads the draft at that
  revision and validates it, then calls the function, which rejects any other
  revision. Because every content change raises the revision, the promoted content
  is exactly what was validated. Validation doesn't need to run in the database.

## API routes

All under `/api/superadmin/marketing`. Every handler calls `requireSuperadmin`
first and then uses the admin client.

| Route | Purpose |
|---|---|
| `GET /` | Current draft (or a starting draft, without writing), published metadata, version list |
| `PUT /draft` | Validate and save with the expected `revision` (and `basePublishedId` on a first save); 409 if stale |
| `POST /publish` | With the expected `revision`: validate the draft, call the publish function, then `revalidateTag` |
| `POST /restore` | With the expected `revision`: validate an archived version and copy it into the draft |
| `POST /upload` | Upload an image to `marketing-assets` |

Middleware doesn't authorize these routes (it only redirects `/admin`), so
`requireSuperadmin` being the first call in every handler is the control, and
tests must prove 401 and 403 for each one.

**Concurrent edits:** the second write gets a 409 and a "reload" message rather
than overwriting the first.

**Migration not applied yet:** when the table or bucket is missing, these routes
return a controlled 503 and the Marketing screen shows "not configured yet"
rather than an unhandled error.

## Images

New public-read `marketing-assets` bucket, created by the migration with its own
`file_size_limit` and `allowed_mime_types`. It has no `authenticated` write
policies, so uploads only happen through the superadmin route using the service
role.

The existing appearance upload route isn't the template: it trusts the declared
type, takes the extension from the filename, and uses a timestamp path with
`upsert: true`. The new route:

- accepts one file per request, JPEG, PNG or WebP, up to **4 MB**. Vercel caps
  serverless request bodies at about 4.5 MB, so a higher limit would fail with a
  platform error instead of our message;
- returns 413 before calling `formData()` if `Content-Length` is over a 4.25 MB
  body ceiling (it counts the whole multipart body, not just the file), then
  enforces the exact 4 MB limit on `file.size` after parsing, because that header
  can be missing or wrong;
- detects the type from the file's leading bytes and rejects anything else. SVG is
  refused because it can carry scripts;
- reads the dimensions with a small hand-written header parser (no new
  dependency) and rejects images over 6000 px on a side;
- generates the object path as a random UUID plus an extension chosen from the
  detected type, with `upsert: false`.

Using a new path for each upload means old published versions keep working, so
objects are not deleted in this version.

`next.config.mjs` currently has no `images` config, so `next/image` can only load
local files. It gets `images.remotePatterns` with the exact protocol, host and port
parsed from `NEXT_PUBLIC_SUPABASE_URL`, limited to
`/storage/v1/object/public/marketing-assets/**`.

`next.config.mjs` is evaluated at **build time**, so each build allows only the
host it was built with, and changing the variable needs a rebuild. Staging builds
get the dev host and production builds the production host. The build fails with a
clear message if the variable is missing or invalid; CI already provides it. Content
stores bucket paths rather than full URLs, so the public URL is always built from
the current environment's host.

`src/__tests__/migrations/storage-buckets.test.ts` already requires a migration
for any bucket the code opens, and this change satisfies it. That test only proves
the bucket is created, so the database tests below also cover its configuration.

## Public page

- `src/app/page.tsx` becomes a thin server component: it loads the content and
  renders `<MarketingPage content={...} />`.
- `src/components/marketing/MarketingPage.tsx` holds the current markup, reading
  from `content`. The preview page renders the same component with the draft.
- `metadata` becomes `generateMetadata`, reading `content.seo` through the same
  cached loader as the page.
- **Preview** is `force-dynamic`, reads the draft directly (never the public cache),
  and sets `robots: { index: false, follow: false }`.

### Failure handling

`getPublishedMarketingContent()` returns `defaultContent` when the row is missing,
the query fails, the table doesn't exist yet, or validation fails. It logs an error
for the failures and a warning for a missing row, which is normal until the first
publish (amended 2026-11-02, plan Decision 6; approved by the owner 2026-11-02). The public page must never return a 500 or render blank because of this
feature.

Older published content may have a lower `schemaVersion` after a code change.
This version only knows version 1; any future change must migrate or fall back
rather than crash.

### Caching

`/` is already dynamic, because the root layout reads request headers. The
published row is read through `unstable_cache` with a `marketing-page` tag and a
5-minute revalidate, and the publish route calls `revalidateTag` (outside the cached
function). Tag invalidation is on demand, so the next request triggers the refresh.
A failed read throws inside the cached function so it isn't cached; the fallback
happens outside it.

## Environments and release

- **Staging reads the dev database**, so publishing on staging doesn't affect
  production. Production content is published separately.
- **Order:** the code is safe before the migration on any environment because the
  page falls back to defaults. Only the Marketing screen shows "not configured yet"
  until it's applied.
  Prod migrations are applied by the owner.
- **Release gate from #334 still applies.** `defaultContent` mentions CB MMQR and
  GTM, which aren't on `main`, so those claims must be cleared or cut from the
  defaults before this reaches `main`. Publishing on production can't help until
  the code is already there.

## Testing

- **Validation:** accepts `defaultContent`; rejects unknown keys, oversized text,
  free-form URLs and bad paths.
- **API:** 401 and 403 on every route; 409 on stale save, publish and restore; 503
  when not configured; upload type, size (413), dimension and leading-byte checks.
- **Database:** publish atomicity, revision mismatch, one-draft and one-published
  constraints, concurrent first saves, a stale first save and stale restore after a
  publish (409), and a first save racing a publish. Table and function ACLs
  are asserted directly (`relacl`, `proacl`), plus the bucket row and the absence of
  write policies on it. The DB test harness grants broad privileges to mirror hosted
  Supabase, so these assertions must check the revokes survive. Per project notes,
  local RLS results aren't proof of production behaviour.
- **Fallback:** missing row, query error and invalid content all give
  `defaultContent`.
- **Rendering:** with `defaultContent`, the page looks the same as today's in the
  browser at desktop and 375px. Hidden sections and items don't render.
- `npm run build`, `tsc` and lint exit 0, with the dev server stopped for the build.

## Risks

- **A publish goes wrong:** restore plus re-publish undoes it, and preview reduces
  the chance.
- **Claims drift from what's live:** editable copy makes it easier to claim
  something that isn't available. The owner is responsible for this once the
  content is editable.
- **Partner logos:** a hidden logo stays in the public bucket and in older
  versions. Removing an organiser from the page doesn't delete the file.
