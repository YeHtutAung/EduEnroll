# Server-side purchase conversion (GTM phase 2)

Status: Design approved by the owner on 2026-11-02. Built on feature/purchase-conversion; not yet on staging.

Phase 1 is `2026-10-30-tenant-gtm-design.md`. It sends `view_item` and
`begin_checkout` from the browser and keeps GTM off every page that shows buyer
details, payment details or tickets.

## Problem

Sky Festival buys ads on Facebook and TikTok. They verified phase 1 on staging on
2026-11-02: tracking works up to the Buy button, and nothing arrives after it.
That is phase 1 working as designed, but their ads can only optimise toward
`begin_checkout`. A paid-order event optimises better.

Firing it from the browser would need a third-party script on the success page,
which shows working tickets. So it is sent from our server after payment is
confirmed.

## Goal

When an order for a configured tenant is paid, and the buyer has that platform's
cookies or click ID, send one purchase event to that platform. A failure or delay here must
never affect a payment, a ticket or a notification.

## Decisions

| Question | Decision |
|---|---|
| Buyer data sent | Ad-click IDs and cookies, IP address, browser user agent, value and currency. **To Meta only, also the email and phone, SHA-256 hashed**, read from the order at send time and never stored, and **the hash of `mm` when the phone is Myanmar's** (the order holds no country, so other buyers send none). **No name or order ref**, and nothing hashed to TikTok. Owner's decisions, 2026-11-03 and 2026-11-04, replacing "browser data only" of 2026-11-02, because Sky Festival needs matched buyers to exclude them from ads and build lookalike audiences. |
| Who gets an event | Any buyer with that platform's pixel cookie or click ID. This includes people who never clicked an ad, because pixels set `_fbp` and `_ttp` for every visitor. Owner's decision, 2026-11-02. A buyer with none of these sends nothing, and their IP is not stored. |
| Platforms | Meta Conversions API and TikTok Events API. GA4 only if a tenant asks. |
| Delivery | A queue table filled by a database trigger, a non-blocking send attempt, and a daily retry. |
| Value | The ticket total, without our fee, converted to the tenant's reporting currency. See Value and currency. |
| Reporting currency | **USD at a rate set per tenant.** Owner's decision, 2026-11-02, because TikTok's supported list omits MMK and Meta's docs don't confirm it. Our own reports stay in MMK. |
| Who enables a tenant | Superadmin only, by SQL, like KBZPay merchant assignments. No UI in v1. |
| Where tokens live | Vercel env vars only. Never in the database, source or logs. |
| Test orders | Only production sends live events. Every other environment needs a test code, or sends nothing. |

### Approaches rejected

- **Send directly from each payment path.** About ten routes would change, and a
  failed send would be lost for good.
- **Server-side GTM.** Extra hosting, and buyer data would pass through a
  container the organiser controls.

## Data flow

1. A buyer lands on a tracked event page from an ad.
2. The page stores `fbclid` and `ttclid` in a first-party cookie.
3. The buyer submits the order. `POST /api/public/enroll` stores the ad context if
   there is a pixel cookie or click ID.
4. Payment becomes `verified`. A database trigger adds one queue row per platform.
5. The server starts a send without waiting for it. Anything left is retried daily.
6. The ad context is deleted once it is no longer needed.

## Components

### 1. Click capture (browser)

A small client component, rendered beside `TenantTagManager`, reads `fbclid` and
`ttclid` from the landing URL and writes them to a cookie:

- Name `kn_ad_click`, `SameSite=Lax`, `Secure`, `Path=/`, 7-day expiry.
- Holds the two IDs and the capture time. Nothing else.
- Existing values are only replaced when the URL carries a new ID.

Our redirects from the root and from `/enroll` forward only validated `fbclid` and
`ttclid`, so an ad linking there keeps them. The rest of the query is never forwarded.

It runs on a tracked path, for a tenant with a valid container ID, when the URL has
no sensitive param. It deliberately does **not** use the rest of the phase 1 guard.
That guard fails on any unknown storage key, which pixels may write (phase 1 open
question 7) and which a failed checkout leaves behind for the rest of the tab, and
a second ad click would then lose its IDs. Writing our own cookie loads no
third-party code, so those checks are not needed here.

The pixels loaded through GTM set `_fbp`, `_fbc` and `_ttp` themselves. These are
first-party cookies, so the order request carries them. Our own cookie covers a
missing `_fbc`, which Meta allows to be built from `fbclid`, and TikTok's click ID.

The phase 1 guarantee is unchanged: no order ref reaches a tracked page, and
leaving a tracked page is still a full page load.

### 2. Ad context (server)

New table `enrollment_ad_context`, **service role only**, one row per enrollment.
It is not on `enrollments` because staff screens and public APIs read that table.

| Column | Notes |
|---|---|
| `enrollment_id` | Primary key, cascades on delete |
| `fbp`, `fbc`, `ttp`, `ttclid` | Length and charset validated. Invalid values are dropped. |
| `client_ip`, `user_agent` | From the request |
| `source_url` | `tenantLinkOrigin(subdomain)` + `/enroll/<intake slug>`, with the slug looked up from the order's first class line. Never from the Host header or a request URL. |
| `created_at` | For retention |

Written by the enroll route after the order exists, on both its single and cart
branches, only for tenants with conversions enabled, and **only if at least one of
`fbp`, `fbc`, `ttp` or `ttclid` is present**. It uses insert-if-absent so idempotent retries are harmless.
A failure here is logged and never fails the order.

### 3. Tenant settings

New table `tenant_conversion_settings`, **service role only**:

| Column | Notes |
|---|---|
| `tenant_id` | Primary key |
| `config_id` | Used in env var names, such as `SKYFESTIVAL`. CHECK `^[A-Z0-9_]+$`. |
| `meta_pixel_id`, `tiktok_pixel_code` | Nullable. Null means that platform is off. |
| `report_currency` | Three uppercase letters. Defaults to `USD`. |
| `report_rate` | Required, greater than 0. One unit of the tenant's currency in the reporting currency, such as USD per 1 MMK. Set with the organiser. |
| `enabled` | Clearing it stops new and queued events, with no deploy |

Env vars, per `config_id`:

- `CONVERSIONS_<ID>_META_TOKEN`, `CONVERSIONS_<ID>_TIKTOK_TOKEN`
- `CONVERSIONS_<ID>_META_TEST_CODE`, `CONVERSIONS_<ID>_TIKTOK_TEST_CODE`

There is no fallback to another tenant's credentials.

### 4. Queue

New table `conversion_events`, **service role only**, with
`UNIQUE (enrollment_id, platform)`:

| Column | Notes |
|---|---|
| `enrollment_id`, `tenant_id`, `platform` | `meta` or `tiktok` |
| `event_id` | SHA-256 of `purchase:<enrollment_id>`. Stable across retries. Not the order ref. |
| `value`, `currency`, `occurred_at` | Snapshot at the moment of payment |
| `status` | `pending`, `sent`, `failed`, `skipped` |
| `attempts`, `last_attempt_at`, `last_error` | `last_error` holds a status code, a platform error code or a short internal reason such as `expired`, never a response body |

A new `AFTER UPDATE OF status` trigger on `payments`, separate from
`trg_payments_sync_enrollment`, adds rows when a payment changes to `verified`:

- One row per platform configured for that tenant, with `ON CONFLICT DO NOTHING`.
- Nothing for an unconfigured or disabled tenant, or a value of zero or less.
- `SECURITY DEFINER`, execute revoked from public, with its body wrapped so that any
  error raises a warning and returns. **A conversion bug must never roll back a
  settlement.**

The trigger is the single choke point: the payment routes elect a winner in
different ways, and all of them change this one column. Manual verification is
included.

#### Value and currency

- Normally `payments.amount - payments.platform_fee`.
- A top-up after a partial payment gets its own row holding only the remainder, for
  example through the KBZPay route. So if the enrollment has an earlier payment with
  `received_amount` set, the value comes from the first such row's
  `amount - platform_fee`, which is the full ticket total. Later partial rows hold
  smaller remainders, so they are not used.
- That amount is multiplied by `report_rate` and rounded to 2 decimals. If the
  result is zero or less, no row is added.
- The event's currency is `report_currency`. The rate in force at the moment of
  payment is the one used, so a later rate change doesn't alter queued rows.
- If the payment has a `provider_currency` that differs from `tenants.currency`, no
  row is added, because the rate wouldn't apply. Only Stripe rows write
  `provider_currency` today. HitPay charges in SGD without setting it, so this check
  doesn't catch it, and conversions don't support a HitPay tenant whose currency
  isn't SGD.

### 5. Sender

`sendPendingConversions(enrollmentId)` in `src/server/conversions/`. It never
throws to its caller, and the whole run has a 6-second deadline.

1. Checks the environment. If it can't send (see Environments), it returns and
   leaves the rows untouched.
2. Claims the enrollment's `pending` rows with a conditional update. A claim older
   than 5 minutes is eligible again. Both platforms deduplicate on `event_id`, so a
   rare double send is harmless.
3. Loads the enrollment, its settings and its ad context, then decides per row:

| Condition | Outcome |
|---|---|
| Enrollment not `confirmed`, or `internal_test_at` set | `skipped` |
| Settings missing, disabled, or that platform's pixel is null | `skipped` |
| Meta row with no `fbp` or `fbc`, TikTok row with no `ttclid` or `ttp`, or no ad context | `skipped` |
| Token missing | stays `pending`, `attempts` unchanged. The log names the variable, never a value. |
| Otherwise | sends |

4. Sends each platform in parallel with a 2.5-second timeout, and records the
   outcome from the status **and the response body**, parsed in memory:

| Result | Outcome |
|---|---|
| Meta 2xx; TikTok body `code` 0 | `sent` |
| Timeout, 5xx, or a rate-limit, auth or permission error | stays `pending`, so a replaced token recovers within 7 days |
| Any other rejection | `failed` |

TikTok is judged only by the body `code`. Its docs conflict on HTTP status: the
return codes page says codes take precedence, with HTTP 200 and an error code as its
example, while the Events pages describe 4xx and 5xx, and list rate limiting (40100)
as HTTP 401. So a 401 can't be treated as an auth failure. Meta uses 4xx with a body
code for both throttling and expired tokens.

**Where it is called.** `issueTicketsForEnrollment` is already called on nearly every
path, but it has early returns, for example for non-event tenants, and it can throw.
Callers depend on that throw to return a retryable result. So the exported function
becomes a thin wrapper that runs the existing body and, in a `finally`, passes the
sender to `waitUntil` from `@vercel/functions`, a new dependency.

**It must not be awaited there.** KBZPay and CB routes have `maxDuration = 10`, the
gateway call can use 6 seconds of that, and the notification runs after this
function and only for the settlement winner. A replay can't send it again, so a
blocking sender could lose the buyer's confirmation for good. With `waitUntil` the
two run side by side. If the function is cut off, the row stays `pending` for the
retry.

The cost for an unconfigured tenant is one indexed query, off the request path.

The PayPay status route does not call it, so those orders wait for the daily retry.
That is acceptable: no tenant using conversions pays by PayPay today.

### 6. Payloads

Meta: `POST https://graph.facebook.com/<version>/<pixel_id>/events`, token in the
body, never the query string.

```json
{ "data": [{
    "event_name": "Purchase",
    "event_time": 0,
    "event_id": "<hash>",
    "action_source": "website",
    "event_source_url": "<source_url>",
    "user_data": { "client_ip_address": "", "client_user_agent": "", "fbp": "", "fbc": "" },
    "custom_data": { "value": 0, "currency": "USD" }
}] }
```

TikTok: `POST https://business-api.tiktok.com/open_api/v1.3/event/track/`, token in
the `Access-Token` header, `event_source: "web"`, `event_source_id: <pixel code>`,
event `Purchase`, with `ip`, `user_agent`, `ttclid`, `ttp`, `value` and `currency`.

The payload builders are pure functions that take an explicit list of fields, so
buyer data cannot reach them by accident.

**Confirmed from the official docs on 2026-11-02.** This is reading only: nothing has
been sent to either API.

- **No contact data needed.** Meta needs at least one customer parameter, and
  `client_user_agent` for website events. Its rejected sets don't include `fbp`,
  `fbc` or `client_ip_address`. An event with only a user agent would be rejected,
  which the per-row rule in section 5 already prevents. TikTok marks email and phone
  as recommended, not required.
- **Lower match quality is the cost.** Meta says unmatched events can't be used for
  attribution or delivery optimisation, and gives no figure for our field set. The
  staging test should record Event Match Quality.
- **TikTok's event name is `Purchase`.** `CompletePayment` is the old name.
- **MMK is why we report in USD.** TikTok's supported list omits it. Meta asks for a
  valid currency code and gives no list for events.
- **Versions:** Meta `v26.0`. TikTok's endpoint is unchanged.
- **Meta rejects a whole request** if any event is more than 7 days old. Each request
  here holds one event.
- **Not found:** TikTok's limit on event age, and any minimum set of `user` fields.
- **Not named by either platform:** which rate-limit code a conversion call returns,
  so the retry lists include every documented one.

### 7. Retry and clean-up

`GET /api/cron/conversions`, run daily from `vercel.json`, with `maxDuration` set.
There is no existing cron to copy, so:

- **Auth:** a `CRON_SECRET` bearer check. It returns 401 if the secret is unset, so
  `Bearer undefined` can never pass.
- **Clean-up runs first,** so a backlog can't block it:
  - Delete ad context when all of the enrollment's rows are finished.
  - Delete ad context older than 8 days when the enrollment has no queue rows. This
    removes data for unpaid orders.
  - Mark `pending` rows older than 7 days `failed`, because Meta rejects older events,
    then delete their context.
- **Then a time budget** over `pending` rows, oldest first, with limited concurrency:
  up to 1,000 rows are read, and no new group of sends starts after 45 seconds, counted
  from the start of the run. A fixed daily batch would let a lapsed token during an
  on-sale expire most rows unsent. Rows not reached wait for the next run.
- **Logs counts only,** per run.
- **A failed clean-up fails the run.** The sends still happen and the counts are still
  logged, then the route returns 500, so a run can't look healthy while IP data isn't
  being deleted.

Daily is the assumption for the current Vercel plan, so a failed send can wait up to
a day. Vercel crons run on production deployments only, so on staging the route is
called by hand, and whoever runs the staging test also runs it afterwards to clear
IP data from the dev database.

## Environments

The database does not separate environments: staging reads the dev database. So
the sender decides from the deployment, not the row:

| Deployment | Behaviour |
|---|---|
| Production (`VERCEL_ENV=production`) | Sends live, with no test code. |
| Anything else, test code set | Sends with the test code. |
| Anything else, no test code | Sends nothing. The row stays `pending`. |

**One exception: a disabled tenant.** The disabled check deliberately runs before this
environment check, so turning a tenant off stops its queued rows even when their token
has already been removed. A disabled tenant's rows, or rows with no settings row, become
`skipped` on any deployment, including one that can't send.

**Test events are not isolated.** Meta's docs say events with a test code still flow
into Events Manager and are used for targeting and measurement. So staging must use a
separate test pixel, never the organiser's live one. Meta may also discard a test
event that doesn't match an account, so a made-up `fbp` showing nothing proves
nothing: test from a real browser.

## Privacy and logging

- Nothing in this feature reads a name or the order ref into a payload. Email and phone reach only Meta's payload, and only hashed. Neither they nor their hashes are logged or stored, and GTM stays off the pages that collect them.
- GA4 `purchase` goes through the same queue, enabled by `ga4_measurement_id`, with the real value in the tenant's currency. Its `client_id` and `session_id` come from the `_ga` cookies at order time and sit in the ad context; a buyer with none gets an anonymous ID from the event hash. `transaction_id` is that hash, never the order ref. Outside production it only calls Google's validation endpoint. Owner's decision, 2026-11-04.
- `referrer_url` goes to Meta only, as the scheme and host of the outside site the buyer arrived from: never a path or query, and never our own pages. It's kept in the `kn_ad_referrer` cookie, then with the rest of the ad context. Owner's decision, 2026-11-04.
- IP and user agent are personal data. They are only stored when a pixel cookie or
  click ID exists, and are deleted as described above. The pixel on the event page
  already sends the same visitors' IP and user agent to the platforms from the browser.
  What this adds is that the visitor purchased, which the privacy wording should say.
- Never log tokens, IPs, cookies, click IDs or platform response bodies.
- The privacy page probably needs a line about sharing this data with ad platforms
  on the organiser's behalf. This is open question 2.

## Known limits

- A purchase does not match if the buyer pays on a different browser or device. An
  ad click in an in-app browser followed by payment in another browser is the likely
  case.
- Buyers whose browser never loaded the pixel send no event, for example with a
  blocker or on a host where GTM is off, so the platforms' purchase counts can be lower
  than actual sales. Our own reports stay the source of truth.
- An order verified more than 8 days after it was created, such as a slow manual
  verification, has lost its ad context and is `skipped`.
- A later refund or rejection does not retract the event.
- Reported value is approximate, because it uses a set rate. Official and market rates
  for MMK can differ a lot, so ROAS is only as good as the rate chosen. It lines up
  with ad spend only if the ad accounts use the same currency.
- Production still needs the tenant's custom domain, because GTM, and so the pixel
  cookies, only load there.

## Testing

- **Unit:** payload builders, including a test that a fully populated enrollment
  produces no raw email or phone, no name and no ref in either payload, and no hash to TikTok.
- **Unit:** `event_id` is stable and does not contain the ref.
- **Unit:** the environment table, cookie validation, and the per-row decisions.
- **Unit:** outcome handling, including TikTok's 200 with a non-zero `code`, rate
  limit, auth failure, 5xx and timeout.
- **Unit:** a sender failure leaves `issueTicketsForEnrollment`'s result and throw
  unchanged, and a sender that hangs past its deadline does not stop the notification.
- **Unit:** cron auth with the secret unset, the sweep's time budget, and clean-up order.
- **Database:** the trigger adds one row per platform; a second transition adds none;
  unconfigured tenants and zero values add none; a top-up reports the full value; a
  forced error inside the trigger does not roll back the payment update.
- **Database, on the dev database:** `has_table_privilege` and RLS state for the new
  tables. The local stack can't prove this, because it returns 42501 for every public
  table. The owner runs the same check on production after the migration.
- **Staging, by hand:** a real paid order from a real browser, on separate test
  pixels with test codes set, seen in Meta's Test Events and TikTok's test tool, with
  Event Match Quality recorded.

## Rollout

1. Migration on the dev database, with the owner's yes. Staging reads the same one.
2. Ship the code to staging. With no settings row, nothing changes.
3. Add a settings row using the test pixels, and staging tokens, test codes and
   `CRON_SECRET` scoped to `staging`. Redeploy, then run the staging test.
4. **Production: migration before code,** as with every recent change. No CI applies
   migrations. Before the migration, the owner confirms `payments.platform_fee`,
   `payments.provider_currency` and `enrollments.internal_test_at` exist on production.
   The trigger's body binds late, so without them the migration would apply cleanly but
   enqueue nothing.
5. Add `CRON_SECRET` and the production tokens in Vercel before the code reaches
   `main`, so the first cron run can authenticate.
6. Add the production settings row.
7. Confirm the first production cron run actually happened, by its log line. A redirect
   or a 401 would otherwise stop retries and IP deletion with nobody noticing.
8. After launch, the owner confirms the first real paid order has `conversion_events`
   rows that reach `sent`. The cron line alone can't prove it.

Also before this merges: Vercel's Node version must be 20 or later. After it merges,
other checkouts must run `npm install`, because `issueTickets.ts` imports
`@vercel/functions` statically.

Turning it off is clearing `enabled`.

## Needed from Sky Festival

- Meta Pixel ID and TikTok Pixel Code, plus a separate test pixel on each for staging.
- The reporting rate, and what currency their ad accounts use.
- Meta Conversions API and TikTok Events API access tokens, entered directly into
  Vercel or handed over securely. Never sent through chat.
- Test codes from Meta Events Manager and TikTok Events Manager.
- Whether they need this before launch, or can start on `begin_checkout`.

## Open questions

1. ~~**Does Meta accept these events without hashed contact data?**~~ Yes, by its
   docs (section 6). Not yet tested against the live API.
2. **Privacy wording.** Does `/privacy` need a line, and who approves it? This
   continues open question 6 in the phase 1 design.
3. **Consent banner.** Open question 2 in the phase 1 design still applies.
4. **Vercel plan.** If the repo's move to a paid plan happens, the retry could run
   more often than daily.
