# Account-bound, non-transferable e-tickets — design

Date: 2026-11-20
Status: revised 2026-11-20 for compatibility with the KuuNyi mobile backend contract
(`kuunyi-app/docs/specs/eduenroll-mobile-backend.md`, "the mobile spec" below). Sign-in identity
decided by the owner 2026-11-20: **email for both web and app** (section 4.1 (a)). The mobile spec
must be updated to match before either side builds buyer sign-in (section 4.1, "What this changes").

## 1. Goal

Stop ticket resale for events that ask for it. A ticket for a protected event:

- belongs to one signed-in buyer account with a verified email, set before payment;
- is shown only on that buyer's signed-in ticket page, never in email or on public order pages;
- is presented at the gate as a QR that changes every 15 seconds and is signed by a key that never leaves the buyer's phone, so a screenshot or a copied page does not work;
- cannot be transferred.

Out of scope, accepted (both need a gate ID check against the account email shown on the ticket
page, which organisers may choose to do):

- a reseller who live-shares their screen on a video call while the new holder stands at the gate;
- a reseller who hands over the account itself (the inbox, the SIM, or a forwarded sign-in code).
  The sign-in factor is the only factor, so the new holder can sign in and bind their phone. Each bind emails the
  account (section 6.1), and binds are limited, but this is a transfer the design cannot block.

## 2. Decisions

| Question | Decision |
|---|---|
| Where the buyer opens the ticket | Web profile now; the KuuNyi mobile app adopts the same scheme later |
| Sign-in identity | Email code (Supabase Auth email OTP), shared by web and app — owner decision 2026-11-20, option (a) in section 4.1 |
| When the buyer signs in | Before checkout, on protected events |
| Live QR method | Phone-bound key: non-extractable WebCrypto key, QR re-signed every 15 s |
| Transfers | None |

**The app later.** Until the app supports bound tickets, protected events are kept out of the app
entirely (section 8.2). When the app does adopt them, it must not use WebCrypto: the key has to be
hardware-backed (Android Keystore, iOS Secure Enclave) through a native module, and register through
the same bind endpoint and `ticket_devices` table. That is a separate future story with its own spec.
The QR format in section 6.2 (P-256, raw r||s) is chosen so both kinds of key can produce it.

## 3. Scope switch

- New column `intakes.ticket_protection boolean not null default false`.
- A check constraint allows `true` only when `ticket_qr_format = 'jwt'`. Events that third parties
  scan by bare ticket id (`uuid`) cannot use protection.
- The flag can change only while the intake has no enrollments. Enforced in the database
  (trigger), not only in the admin form.
- Existing events and orders are untouched. Nothing is converted.

## 4. Buyer accounts

Buyer accounts are shared with the KuuNyi mobile app. Everything here must stay compatible with the
mobile spec sections 4.3, 4.4, 6.1, 7 and 11.

### 4.1 Sign-in identity — decided: email for web and app

**Owner decision, 2026-11-20: option (a).** Buyers sign in with a 6-digit email code (Supabase Auth
email OTP) on the web and in the app. One person, one account, one ticket list.

- Supabase Auth SMTP is set to Resend in each project (the default mailer allows only a few emails
  per hour). Dev first.
- The verified email on the auth user is the identity. `buyer_profiles.email` copies it; the order
  email for a protected event is this email (section 5).
- **Email change is not supported** in this version, mirroring the mobile spec's rule for phone:
  `auth.updateUser({ email })` is blocked for buyers, and `requireBuyer` rejects a token whose auth
  email differs from `buyer_profiles.email`.
- Phone becomes an optional, unverified contact field (`buyer_profiles.phone_e164`), used to pre-fill
  forms. It is no longer unique or required.
- No SMS cost per sign-in, and buyers without a Myanmar number can sign in.

**What this changes in the mobile spec** (must be updated before either side builds buyer sign-in;
that is the app team's document, not edited by this work):
- 4.1: phone OTP and the SmsPoh Send SMS Hook are replaced by email OTP. The durable OTP caps move to
  per-email and per-IP. `signInWithOtp({ email })` / `verifyOtp({ email, token, type: 'email' })`.
- 4.1 App Review: Supabase's fixed-code test numbers are phone-only, so the reviewer account needs
  another way in (for example a reviewer address on a domain we control, read by us, or a
  superadmin-issued reviewer code). To be designed in the mobile spec.
- 4.2: "phone change not supported" becomes "email change not supported".
- 4.3: `requireBuyer` matches on email, not phone, and returns `email`.
- 4.4: `email` NOT NULL UNIQUE (from the auth user, verified); `phone_e164` nullable, not unique.
- 4.5: `POST /me` takes the email from the auth user, never the body; `phone` moves to the editable
  fields.
- 11.2: web deletion is by email code (`signInWithOtp({ email, options: { shouldCreateUser: false } })`),
  with the same "if an account exists, it has been deleted" answer.

**Options not chosen**, kept for the record: (b) phone stays the identity and protected events add a
verified email on the same account (SMS cost per web sign-in, `+959` numbers only); (c) separate web
and app accounts (two unconnected accounts per person).

### 4.2 Tables

If this work lands before #451, it creates `buyer_profiles` and `enrollments.buyer_id` in **the full
mobile spec 4.4 / 7.1 shape**, adjusted for email identity, not a reduced one:

- `buyer_profiles`: `id` (PK, FK `auth.users(id)` ON DELETE CASCADE), `email` (NOT NULL UNIQUE,
  from the verified auth user), `phone_e164` (nullable, not unique), `name`, `locale` (`my` | `en`,
  default `my`), `created_at`, `updated_at`, `deleted_at`, `is_reviewer` (default false,
  superadmin-set).
- `enrollments.buyer_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`, index
  `(buyer_id, enrolled_at DESC)`, and the `p_buyer_id` parameter on `submit_enrollment` /
  `submit_cart_enrollment` with the idempotency rule from mobile spec 7.1.

### 4.3 `requireBuyer`

One `requireBuyer` in `src/lib/api.ts`, used by web and mobile routes, behaving exactly as mobile
spec 4.3:

- Verify with `supabase.auth.getUser(token)`, which asks the Auth server. Never a local-only check
  (`getClaims`, or verifying the JWT with the project key): a deleted user or ended session must
  fail even while the JWT is unexpired. Web routes take the token from the cookie session; the call
  is the same.
- `401 UNAUTHENTICATED` **only** for a missing token or a real Auth rejection (a 4xx such as 401,
  403 `bad_jwt`, `session_not_found`, `user_not_found`, expired).
- `503` with code `SERVER` when Auth is unreachable, times out, answers 5xx, or answers 429. An Auth
  outage is never a 401, because the app signs the buyer out on 401.
- Require a `buyer_profiles` row with `deleted_at IS NULL` whose `email` equals the auth user's
  verified email.
- A staff account (a `users` row exists) → `403 FORBIDDEN`.
- Read `session_id` from the token only after `getUser` succeeds. A token without it → 401.
- Returns `{ buyerId, email, isReviewer, sessionId }`.

### 4.4 Staff gates

Buyers and staff share `auth.users`, so every staff gate must reject a buyer. Tests in both
directions:
- `requireAuth` / `requireOwner` (`src/lib/api.ts`), which already return 403 without a `users` row,
  and `requireSuperadmin` (`src/lib/superadminAuth.ts`);
- `src/middleware.ts`: today any signed-in user on `/login` is redirected to `/admin/dashboard`,
  and `/admin` only stops signed-out users. Both must tell a buyer apart from staff (buyer on
  `/login` stays there or goes to `/account`; buyer on `/admin` goes to `/account`);
- the admin and superadmin layouts.

**Email codes and staff accounts.** Turning on email OTP turns it on for every user in the project,
staff included, because staff also sign in by email. Without a rule, a staff account could be
entered with only its inbox, without its password. So:
- Every staff gate above (`requireAuth`, `requireOwner`, `requireSuperadmin`, middleware, layouts)
  accepts a staff session only when the token's `amr` claim shows a `password` sign-in. A staff
  session made with an email code is treated as signed out for admin and gets 403 on admin APIs.
  The plan must confirm the `amr` contents on the dev project before relying on it.
- `requireBuyer` already refuses staff (403), so a staff member who wants to buy a protected ticket
  uses a different email. The sign-in page says so when a staff email asks for a code.

### 4.5 Sessions and ticket lists

- Web sessions are per host (tenant subdomain or custom domain): one account, signed in separately
  on each tenant site. `/account/tickets` lists **only the current tenant's** tickets.
- The app's `/api/mobile/v1/me/tickets` is **cross-tenant**: every tenant's tickets for the buyer.
  The two lists are meant to differ; neither should be "fixed" to match the other.

### 4.6 Prerequisite

The private security advisories that #451 says must be closed before buyer sign-up is enabled.

## 5. Checkout on a protected event

1. The enrollment form first asks for the buyer's email and sends a code; the buyer enters it and is
   signed in. An already-signed-in buyer skips this. A mistyped email can't receive the code, so
   typo'd order emails cannot happen on protected events.
2. The email field is filled from the account's verified email and read-only. The read-only field
   is only a convenience: the enroll routes (`src/app/api/public/enroll/route.ts`,
   `src/app/api/public/enroll/[slug]/route.ts`) overwrite the order email with the account's
   verified email on the server for protected intakes.
3. The submit RPCs take `buyer_id` from the server-verified session, never from the request body.
   The route rejects a protected-event submission with no buyer session (401).
4. All tickets in the order belong to the buyer. For orders with several attendees (for example
   one per runner), everyone enters on the buyer's phone. Attendee names stay as data on the
   ticket; they do not create accounts.
5. Admin "Edit Email" (#425) is refused for protected orders in
   `src/app/api/admin/enrollments/[id]/email/route.ts` (409), and the button is hidden. The email
   is the identity.

## 6. Phone-bound QR

### 6.1 Binding a phone

- **One key per device and account**, not per ticket. The first time a signed-in buyer opens any
  protected ticket on a browser, the page creates an ECDSA P-256 key pair with WebCrypto,
  `extractable: false`, and stores the `CryptoKey` in IndexedDB keyed by buyer id. Every ticket the
  buyer opens on that browser is bound to that same key, so a multi-attendee order works from one
  phone. (P-256 rather than Ed25519 because WebCrypto Ed25519 is not yet on every phone browser our
  buyers use.)
- The page exports the public key as `raw` (65-byte uncompressed point) and sends it base64url.
  The server stores it as-is and imports it with `crypto.createPublicKey` from a JWK built from
  the x/y halves. No point compression anywhere.
- `POST /api/me/tickets/{ticketId}/device` with that public key. `requireBuyer()`; the ticket must
  belong to the buyer, be valid, and be on a protected intake.
- New table `ticket_devices`: `id`, `ticket_id`, `buyer_id` (FK `auth.users(id)` **ON DELETE SET
  NULL**, so rows outlive a deleted account), `public_key`, `created_at`, `revoked_at`, `revoked_by`
  (`rebind` | `admin` | `account_deleted`). Partial unique index: one row with `revoked_at is null`
  per ticket. Rows are never deleted; they are the audit trail.
- Binding the key that is already active for the ticket is a no-op (returns the current token,
  uses no bind).
- Limit: 3 self-service binds per ticket, counted as the rows created after the ticket's latest
  `revoked_by = 'admin'` row (or all rows if there is none). The 4th returns 429 with a message to
  contact the organiser. Admin reset (section 9) revokes with `revoked_by = 'admin'`, which starts a
  new count.
- **A re-bind by the same account after the key was lost still counts.** To the server, "same
  buyer, browser data wiped" and "account handed to someone else, new phone" look identical: the
  same account, a browser with no key. Exempting the first would exempt the second, which is the
  resale path the limit exists to slow. Instead, losing the key is made rarer and cheaper:
  - the ticket page asks iOS buyers to add it to the Home Screen, which keeps its storage out of
    Safari's 7-day deletion (section 6.3);
  - every bind is emailed to the account, so an unexpected one is visible;
  - the limit is 3, not 1, and admin reset (section 9) clears it at a help desk.
- The limit check, revoking the old row and inserting the new one run in **one SQL function**
  (service role only), locking the ticket row, so concurrent binds cannot exceed the limit or leave
  two active rows. supabase-js has no transactions, so this cannot be done in the route.
- Every successful bind after the first sends the account a short email ("Your ticket was opened on
  a new phone").
- Response: a bound ticket token, Ed25519-signed with the existing ticket key
  (`src/lib/tickets/sign.ts`), claims `{ jti, eid, tier, admits, exp, typ: "bound", dk }` where `dk`
  is the device public key. Stored in IndexedDB beside the key. Its `exp` is informational: the scan
  route uses `tickets.exp` and the event dates from the DB, as it does today, so a later expiry
  change needs no re-bind.

### 6.2 What the QR holds

```
k2.<bound token>.<ts>.<devsig>
```

Exactly six dot-separated segments: `k2`, the three segments of the bound token, `ts`, `devsig`.
Anything else is not a `k2` token.

- `ts`: Unix seconds as a canonical decimal string (no sign, no leading zeros), refreshed every
  15 seconds. The page reads server time once on load (from the bind response) and adds that offset
  to the phone clock, so a wrong phone clock does not matter while the page stays open.
- `devsig`: ECDSA P-256 with SHA-256 over the UTF-8 bytes of `k2|<jti>|<ts>`, using the `ts` segment
  exactly as it appears in the QR. WebCrypto produces raw r||s (64 bytes), sent base64url. The
  server verifies with `crypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig)`.
- Expected length is about 400 characters. The plan must render a real one at the current ticket
  QR size (240 px minimum) and confirm the scanner reads it from a phone screen at normal
  brightness. If not, shorten `dk` or the token claims before going further.

### 6.3 Offline behaviour

- Once the page has loaded, the key, token and signing are all local, so the QR keeps changing with
  no signal for the life of the token.
- Reloading the page with no signal fails. The ticket page says to open it before arriving and keep
  it open. An offline page cache (service worker) is a later improvement.
- Clearing site data, or a private-browsing window, loses the key. The buyer binds again, which
  counts toward the 3.
- **iOS Safari deletes script-written storage, IndexedDB included, after 7 days of Safari use
  without a visit to the site.** A buyer who binds a week or more before the event and doesn't open
  the page again can lose the key and arrive needing a re-bind, with signal. Mitigations: the ticket
  page asks iOS buyers to add it to the Home Screen (Home Screen web apps keep their own storage,
  outside that rule); the confirmation and reminder messages say to open the ticket again before the
  event day; and binding is deferred until the buyer first opens the ticket, not done at purchase.
  The plan must confirm the current WebKit behaviour on a real iPhone before relying on the Home
  Screen exemption.

## 7. Scanning

`POST /api/scans` (`src/app/api/scans/route.ts`) gains a protected path:

Checks that need no database run first, keeping the route's rule that a forged token cannot probe
for ticket existence:

1. If the token starts with `k2.`, it must have exactly six segments. Verify the bound token's
   Ed25519 signature and that `typ = "bound"`.
2. Verify `devsig` with the `dk` from the signed claims.
3. Accept `ts` only within `[now − 20 s, now + 10 s]` of server time (one 15-second refresh plus
   scan and network delay; the page corrects for the phone clock, section 6.2).

Then the database:

4. Load the ticket as today (scoped to the scanner's tenant), plus its intake's
   `ticket_protection` and its active `ticket_devices` row.
5. The intake must be protected (a `k2` token on an unprotected intake is a 404), and `dk` must equal
   the active row's `public_key`. No active row, or a different key (a revoked phone), is a 404.
6. Then the existing single-use or once-per-day admission update, with the existing 409 "already
   scanned" response unchanged.

A plain (non-`k2`) token for a ticket whose intake has `ticket_protection = true` is rejected with
the same 404. This shuts out tokens that leaked before protection or through an old email.
Unprotected events take the current path, unchanged.

Every rejection keeps the existing rule: one indistinguishable 404 for "not an admission". A load
error on the ticket, intake or `ticket_devices` is a 500, never a 404.

The same `ts` and `devsig` can be scanned again inside the window, but only until the first
admission; after that the existing 409 applies. A copy forwarded in real time and used inside
those 30 seconds is the live-sharing case from section 1.

**Scanner app (kuunyi-scanner, separate repo):** must accept the `k2.` format in its offline preview
and must send `token` in the scan request. Our notes say it currently sends no `token`, which already
makes every scan fail against the current route. Protected tickets need the scanner online, because
a revoked phone can only be detected on the server. Both scanner changes are required before any
gate test.

## 8. Closing the other places a QR appears (protected events)

### 8.1 Web

| Surface | Change |
|---|---|
| E-ticket email attachment, `buildEticketEmailAttachment` in `src/server/tickets/eticketEmailAttachment.ts` | The protection check lives **here** (it already loads the intake): no PDF for protected intakes, whichever caller asks |
| Its six callers: `src/server/payments/notifyEnrollmentConfirmed.ts`, `src/server/notifications/dispatchPaymentApproved.ts`, `src/app/api/webhooks/mmpay/route.ts`, `src/app/api/webhooks/abank/route.ts`, `src/app/api/public/payments/abank/status/route.ts`, `src/app/api/admin/enrollments/[id]/resend-email/route.ts` (admin Resend Email) | Each builds its own email body; for protected intakes the body has no QR and a "View your ticket" button to `/account/tickets`. One shared helper decides, so a caller cannot forget |
| `GET /api/public/enrollment/[ref]` | Omits each ticket's `jwt` and `qr` fields for protected intakes (server-side) |
| Checkout success page and `/enroll/payment/[ref]` | Both read the route above, so they lose the QR with it; they show an "Open My Tickets" button instead of the QR and PDF download |
| QR export CLI script `scripts/export-ticket-qr.ts` (#456) | Ticket ids only for protected intakes; a plain token is refused at the gate anyway |

Admin, Telegram, messenger and the status lookup page show no ticket QR today (checked
2026-11-20). Tests assert the API response and each email caller's output, not only the page markup.

### 8.2 Mobile API (until the app supports bound tickets)

Without this, the app could buy a protected ticket the gate then rejects: `POST
/api/mobile/v1/orders` is not behind the web checkout's sign-in gate, and `/me/tickets` returns the
plain ticket JWT, which section 7 refuses with a 404. The `/api/mobile/v1/*` routes are not on
`dev` yet (checked 2026-11-20); these rules bind whichever of this work and #451 lands second.

| Surface (mobile spec section) | Change |
|---|---|
| Event listing conditions (6.1) | Add **`intakes.ticket_protection = false`** to the conditions. 6.1 is per tenant, so this one is checked per event: `GET /events` omits protected events, and `GET /events/{tenant}/{slug}` and `POST /orders` return `EVENT_NOT_SUPPORTED` for them. The reviewer exception does not override it |
| `POST /api/mobile/v1/orders` (7.1) | Re-checks protection server-side and returns `EVENT_NOT_SUPPORTED`, so a stale app or a direct call can't buy one |
| `GET /api/mobile/v1/me/tickets` (7.4) | Never returns `qr` (or any JWT) for a protected ticket. It is left out of the snapshot entirely, because `Ticket.qr` is a required string in the contract |
| `GET /api/mobile/v1/me/orders/{ref}` (7.4) | Same: no protected ticket in `tickets[]`, so no `qr`. The order itself can still be listed |
| Issue on read and re-sign on read (7.4) | Never sign a plain JWT for a protected ticket on these paths |

When the app gains hardware-backed binding (section 2), it gets its own bind and ticket contract,
and these rules are relaxed in that story, not before.

## 9. Pages and admin

**Buyer:**
- `/account`: email code sign-in, and sign-out.
- `/account/tickets`: the current tenant's tickets for this buyer, grouped by event.
- `/account/tickets/[id]`: the live QR with a 15-second countdown, event and tier, the account email
  (and the attendee name where the order has one), and the "open before you arrive, keep this page
  open" notice. Myanmar and English text like the other public pages.

**Admin:**
- Event settings: the "Account-bound tickets" toggle, disabled once the event has orders, with an
  explanation.
- Order or ticket view: the phone status (bound / not bound, last bound time, binds used).
- "Reset phone" per ticket: revokes the active device (`revoked_by = admin`) and resets the bind
  count. Logged to the existing admin audit trail if there is one, otherwise to `ticket_devices`.

**Account deletion is never blocked.** These are also the app's accounts, and Apple guideline
5.1.1(v) and Google Play both require that users can delete their account in the app. Mobile spec
11 deletes immediately; this feature keeps that:

- **Warning before confirming**, in the app (`DELETE /api/mobile/v1/me`), on the web deletion page
  (mobile spec 11.2) and on `/account`: tickets for account-bound events stop working at once and
  cannot be recovered, by signing up again or by order reference. The mobile spec 11.1 text
  ("upcoming tickets stay valid") gets this exception. The app shows the line always, not only when
  the account holds such a ticket, so no new API is needed.
- **Server step**, added to mobile spec 11.1 after step 1 (`deleted_at` set) and before
  `auth.admin.deleteUser`: revoke every active `ticket_devices` row of the buyer with
  `revoked_by = 'account_deleted'`. Idempotent like the other steps, and also run by the 15-minute
  sweep (11.1 step 6), so a deletion that fails part-way still revokes.
- After `deleteUser`, `enrollments.buyer_id` and `ticket_devices.buyer_id` become NULL (SET NULL).
  The ticket has no owner and no active phone, so it can never be bound or admitted again. The order,
  payment and ticket rows stay as the organiser's records, under the retention rule in mobile
  spec 11.
- Any refund for the dead ticket is the organiser's call, as today. The warning says so.

## 10. Migrations

One migration, applied to the dev DB first, and to production before the code that reads it:
- `intakes.ticket_protection` plus check constraint plus lock trigger;
- `buyer_profiles` and `enrollments.buyer_id` if #451 has not created them, in the full mobile spec
  shape (section 4.2);
- `ticket_devices` plus partial unique index plus RLS (buyer reads own rows; writes via service role
  only);
- submit RPC changes to accept and require `buyer_id` for protected intakes.

Hash guards on function bodies must strip `chr(13)` (see the CRLF note in the repo's migration
conventions).

## 11. Testing

- **Unit:** bound token sign and verify; `k2` envelope parse (wrong segment count, non-canonical
  `ts`); `devsig` verify against a key made by WebCrypto; the time window edges; a wrong `dk`; a
  plain token refused for a protected ticket.
- **Database:** the bind function's limit, reset after an admin revoke, and two concurrent binds
  leaving exactly one active row.
- **Route:** `/api/scans` protected and unprotected paths, 404 vs 500 vs 409; `/api/public/enrollment/[ref]`
  omitting `jwt` and `qr`; each email caller sending no PDF for a protected order;
  `/api/me/tickets/{id}/device` ownership and limit; the enroll routes overriding the email; Edit
  Email refused; `requireBuyer` vs every staff gate in section 4.4, including middleware, in both
  directions.
- **Staff and email codes (section 4.4):** a staff account signed in with an email code gets 403 on
  admin and superadmin APIs and is sent away from `/admin`; the same account signed in with its
  password is unaffected.
- **`requireBuyer` (section 4.3):** auth email different from `buyer_profiles.email` → 401;
  Auth rejection → 401; Auth unreachable, timeout, 5xx and 429 →
  503 `SERVER`, never 401; staff account → 403; deleted profile → 401; token without `session_id`
  → 401; claims never read before `getUser` succeeds.
- **Mobile routes (section 8.2):** `GET /events` omits a protected event; `GET
  /events/{tenant}/{slug}` and `POST /orders` return `EVENT_NOT_SUPPORTED` for one (including for a
  reviewer); `/me/tickets` and `/me/orders/{ref}` return no `qr` or JWT for a protected ticket,
  including the issue-on-read path.
- **Deletion (section 9):** deleting an account with a bound protected ticket succeeds, revokes the
  device with `account_deleted`, and the ticket's next scan is a 404; a retried or swept deletion
  revokes too.
- **Staging, with real phones:** buy on a protected test event; bind phone A; scan succeeds. A
  screenshot of A's QR scanned after 60 s fails. Phone B binds, then A's live QR fails and B's
  passes. Local runs are not evidence for the auth and RLS parts.

## 12. Dependencies and order

1. Close the private security advisories (#451 prerequisite).
2. Sign-in identity: **decided 2026-11-20, email for web and app** (section 4.1). The mobile spec
   (kuunyi-app) and #451 are updated to email sign-in, including a new App Review reviewer route,
   before either side builds buyer sign-in.
3. Resend SMTP set for Supabase Auth on dev, then staging. Staff gates require a `password` sign-in
   (section 4.4) **before** email OTP is turned on in any project.
4. kuunyi-scanner: send `token`, accept `k2.`.
5. This feature: migration, accounts, checkout, binding, scan path, surface closing, pages, admin.
6. Staging phone test (section 11), then production through the normal dev → staging → main flow,
   with the migration applied to production before the code.

## 13. Risks

- **Live screen-sharing** defeats it (accepted, section 1).
- **Lost or cleared phone at the gate** with no signal: the buyer cannot re-bind. Organisers need a
  help-desk path (admin reset plus the buyer signs in on the spot with signal).
- **Phone clock changed after the page loaded** (rare): the server-time offset taken on load
  (section 6.2) goes wrong and scans fail the window until the page is reloaded with signal.
- **Account handover** is a transfer the design cannot block (section 1).
- **iOS storage deletion:** Safari can delete the IndexedDB key after 7 days without a visit
  (section 6.3), so early buyers may need a re-bind at the gate. Home Screen install and reminders
  reduce it; a help desk with admin reset covers the rest.
- **Email deliverability:** every buyer sign-in, web and app, depends on Resend reaching the buyer.
  Code emails must be monitored on launch day, and a Resend outage stops new sign-ins everywhere.
- **Staff accounts and email codes:** email OTP is project-wide, so staff gates must refuse
  non-password sessions (section 4.4) before it is turned on.
- **App and web drift:** until the app supports bound tickets, protected events are invisible in
  the app (section 8.2). A buyer may see an event on the web that the app doesn't list.
